// Copyright 2014. A Medium Corporation.

import { EventEmitter } from 'events';
import childProcess, { exec } from 'child_process';
import closureTemplates from 'closure-templates';
import fs from 'fs-extra';
import path from 'path';
import Q from 'q';
import SoyVmContext from './SoyVmContext';
import SoyOptions from './SoyOptions';
import copy from './copy';

/**
 * The key in vmContexts for the default vm context (with no locale).
 */
const DEFAULT_VM_CONTEXT = 'default';

/**
 * Resolved path to the executable jar for the Closure Template compiler.
 * @type {string}
 */
const PATH_TO_SOY_JAR = closureTemplates['SoyToJsSrcCompiler.jar'];

/**
 * Emits the compile event. Swallows any errors thrown by the receiver.
 */
function emitCompile(emitter, err) {
  try {
    emitter.emit('compile', err, !!err);
  } catch (e) {
    console.error('soynode: emit error', e);
  }
}

/**
 * Callback that will log an error.
 */
function logErrorOrDone(err) {
  if (err) console.error('soynode:', err);
  else console.log('soynode: Done');
}

/**
 * The main public API of soynode.
 * @constructor
 */
function SoyCompiler() {
  /** @private {SoyOptions} */
  this._options = this.getDefaultOptions();

  /**
   * VM Context that is used as the global when fetching templates.  The end result is that this
   * object contains references to the JS functions rendered by Soy.
   * @type {Object.<string, SoyVmContext>}
   */
  this._vmContexts = {};

  /**
   * Map of filenames that have a watch to the last time it was called.
   * @param {Object.<number>}
   */
  this._watches = {};
}

/** @return {SoyOptions} */
SoyCompiler.prototype.getDefaultOptions = function() {
  return new SoyOptions();
};

/**
 * Sets options which affect how soynode operates.
 * @param {{
 *     tmpDir: string=, //Deprecated
 *     outputDir: string=,
 *     uniqueDir: boolean=,
 *     allowDynamicRecompile: boolean=,
 *     eraseTemporaryFiles: boolean=}}} opts
 */
SoyCompiler.prototype.setOptions = function(opts) {
  this._options.merge(opts);
};

/**
 * Gets a reference to a template function.
 *
 * Note: If dynamic recompilation is enabled the reference will not get updated.
 *
 * @param {string} templateName
 * @param {string=} vmType optional type of the vm
 * @return {function (Object) : string}
 */
SoyCompiler.prototype.get = function(templateName, vmType) {
  return this.getSoyVmContext(vmType || DEFAULT_VM_CONTEXT).get(templateName);
};

/**
 * Renders a template using the provided data and returns the resultant string.
 * @param {string} templateName
 * @param {Object=} data
 * @param {Object=} injectedData optional injected data available via $ij
 * @param {string=} vmType optional type of the vm
 * @return {string}
 */
SoyCompiler.prototype.render = function(
  templateName,
  data,
  injectedData,
  vmType
) {
  // Certain autoescape modes of closure-templates return a Content object
  // instead of a string, so force a string.
  return String(this.get(templateName, vmType)(data, null, injectedData));
};

/**
 * Gets the SoyVmContext object for the for the given locale, or the default if no locale is given.
 *
 * @param {string=} vmType optional type of the vm
 */
SoyCompiler.prototype.getSoyVmContext = function(vmType) {
  vmType = vmType || DEFAULT_VM_CONTEXT;

  if (!this._vmContexts[vmType]) {
    this._vmContexts[vmType] = new SoyVmContext(vmType, this._options);
  }

  return this._vmContexts[vmType];
};

/**
 * Gets the vm context for the given locale, or the default if no locale is given.
 *
 * @param {string=} vmType optional type of the vm
 * @return {Object}
 */
SoyCompiler.prototype.getVMContext = function(vmType) {
  return this.getSoyVmContext(vmType).getContext();
};

/**
 * Compiles all soy files within the provided directory and loads them into memory.  The callback
 * will be called when templates are ready, or an error occurred along the way.
 * @param {string} inputDir
 * @param {function (Error, boolean)=} callback
 * @return {EventEmitter} An EventEmitter that publishes a "compile" event after every compile
 *     This is particularly useful if you have allowDynamicRecompile on, so that your server
 *     can propagate the error appropriately. The "compile" event has two arguments: (error, success).
 */
SoyCompiler.prototype.compileTemplates = function(inputDir, callback) {
  const options = this._options;
  const emitter = new EventEmitter();
  if (options.allowDynamicRecompile) {
    emitter.on('compile', logErrorOrDone);
  }
  if (callback) {
    emitter.once('compile', callback);
  }
  this._compileTemplatesAndEmit(inputDir, emitter);
  return emitter;
};

/**
 * Compiles all soy files within the provided array and loads them into memory.  The callback
 * will be called when templates are ready, or an error occurred along the way.
 * @param {Array.<string>} files
 * @param {function (Error, boolean)=} callback
 * @return {EventEmitter} An EventEmitter that publishes a "compile" event after every compile.
 */
SoyCompiler.prototype.compileTemplateFiles = function(files, callback) {
  const emitter = new EventEmitter();
  if (callback) {
    emitter.once('compile', callback);
  }
  const outputDir = this._createOutputDir();
  const { inputDir } = this._options;
  const self = this;
  this._maybeUsePrecompiledFiles(outputDir, files)
    .then(dirtyFiles => {
      self._maybeSetupDynamicRecompile(inputDir, outputDir, files, emitter);
      return self._compileTemplateFilesAndEmit(
        inputDir,
        outputDir,
        files,
        dirtyFiles,
        emitter
      );
    })
    .done()
    .catch(err => {
      throw err;
    });
  return emitter;
};

/**
 * Resolves the output directory from the current options.
 * @return {string}
 * @private
 */
SoyCompiler.prototype._createOutputDir = function() {
  const options = this._options;
  let dir = options.outputDir || options.tmpDir;
  if (options.uniqueDir !== false) {
    const timeDirectory = new Date().toISOString().replace(/:/g, '_');
    dir = path.join(dir, timeDirectory);
  }
  return dir;
};

/**
 * Compiles all soy files, but takes an emitter to use instead of a callback.
 * @see compileTemplates for the emitter API.
 * @param {string} inputDir Input directory from where the compiler spawns.
 * @param {string} outputDir
 * @param {Array.<string>} allFiles All files, expressed relative to inputDir
 * @param {Array.<string>} dirtyFiles Dirty files, expressed relative to inputDir
 * @param {EventEmitter} emitter
 * @return {Promise}
 * @private
 */
SoyCompiler.prototype._compileTemplateFilesAndEmit = function(
  inputDir,
  outputDir,
  allFiles,
  dirtyFiles,
  emitter
) {
  const self = this;
  return this._compileTemplateFilesAsync(
    inputDir,
    outputDir,
    allFiles,
    dirtyFiles
  ).then(
    () => self._finalizeCompileTemplates(outputDir, emitter),
    err => emitCompile(emitter, err)
  );
};

/**
 * Compiles all soy files, returning a promise.
 * @see compileTemplates for the emitter API.
 * @param {string} inputDir Input directory from where the compiler spawns.
 * @param {string} outputDir
 * @param {Array.<string>} allFiles All files, expressed relative to inputDir
 * @param {Array.<string>} dirtyFiles Dirty files, expressed relative to inputDir
 * @return {Promise}
 * @private
 */
SoyCompiler.prototype._compileTemplateFilesAsync = function(
  inputDir,
  outputDir,
  allFiles,
  dirtyFiles
) {
  const options = this._options;
  let outputPathFormat = path.join(
    outputDir,
    '{INPUT_DIRECTORY}',
    '{INPUT_FILE_NAME}.js'
  );

  // Arguments for running the soy compiler via java.
  let args = [
    '-classpath',
    [PATH_TO_SOY_JAR].concat(options.classpath).join(path.delimiter),
    'com.google.template.soy.SoyToJsSrcCompiler',
    '--shouldGenerateJsdoc',
  ];

  // Handling soy compiler options.
  if (options.shouldGenerateJsdoc) {
    args.push('--shouldGenerateJsdoc');
  }

  if (options.useClosureStyle || options.shouldProvideRequireSoyNamespaces) {
    args.push('--shouldProvideRequireSoyNamespaces');
  } else if (options.shouldProvideRequireJsFunctions) {
    args.push('--shouldProvideRequireJsFunctions');
  }

  if (options.cssHandlingScheme !== undefined) {
    args.push('--cssHandlingScheme', options.cssHandlingScheme);
  }

  if (options.pluginModules && options.pluginModules.length > 0) {
    args.push('--pluginModules', options.pluginModules.join(','));
  }

  if (options.locales && options.locales.length > 0) {
    args.push('--locales', options.locales.join(','));

    if (options.locales.length > 1) {
      outputPathFormat = path.join(
        outputDir,
        '{LOCALE}',
        '{INPUT_DIRECTORY}',
        '{INPUT_FILE_NAME}.js'
      );
    }
  }

  if (options.messageFilePathFormat) {
    args.push('--messageFilePathFormat', options.messageFilePathFormat);
  }

  if (!options.shouldDeclareTopLevelNamespaces) {
    args.push('--shouldDeclareTopLevelNamespaces', 'false');
  }

  if (options.protoFileDescriptors) {
    args.push('--protoFileDescriptors', options.protoFileDescriptors);
  }

  args.push('--outputPathFormat', outputPathFormat);

  // List of files
  args = args.concat(dirtyFiles);

  let terminated = false;
  const self = this;

  function runCompiler() {
    if (!dirtyFiles.length) {
      return Q.resolve(true);
    }

    const deferred = Q.defer();

    let stderr = '';

    function onExit(exitCode) {
      if (terminated) return;

      if (exitCode !== 0) {
        // Log all the errors and execute the callback with a generic error object.
        terminated = true;
        console.error('soynode: Compile error\n', stderr);
        deferred.reject(new Error('Error compiling templates'));
      } else {
        deferred.resolve(true);
      }
    }

    // Execute the command inside the input directory.
    const cp = childProcess.spawn('java', args, { cwd: inputDir });

    cp.stderr.on('data', data => {
      stderr += data;
    });

    cp.on('error', err => {
      stderr += String(err);
      onExit(1);
    });

    cp.on('exit', onExit);
    return deferred.promise;
  }

  return runCompiler().then(() => {
    let vmTypes = [DEFAULT_VM_CONTEXT];
    if (options.locales && options.locales.length > 0) {
      vmTypes = options.locales.concat(); // clone
    }

    function next() {
      if (vmTypes.length === 0) {
        return Q.resolve(true);
      }
      return self
        ._postCompileProcess(outputDir, allFiles, vmTypes.pop())
        .then(next);
    }
    return next().fail(err => {
      console.error('Error post-processing templates', err);
      throw err;
    });
  });
};

/**
 * Performs a recursive directory traversal of the given directory, accumulating all files with the
 * provided extension.  The resultant array is a list of paths relative to the input directory.
 * @param {string} directory
 * @param {string} extension
 * @param {function(Error, Array.<string>)} callback
 */
function findFiles(directory, extension, callback) {
  const files = [];
  const stack = [directory];

  function next() {
    if (stack.length === 0) {
      callback(null, files);
    } else {
      const dir = stack.pop();
      fs.stat(dir, (err, stats) => {
        if (err) return callback(err, []);
        if (!stats.isDirectory()) return next();
        return fs.readdir(dir, (error, dirContents) => {
          if (error) return callback(error, []);
          dirContents.forEach(file => {
            const fullpath = path.join(dir, file);
            // If the file is a soy file then push it onto the files array.
            if (file.substr(-1 - extension.length) === `.${extension}`) {
              files.push(path.relative(directory, fullpath));

              // If the file has no extension add it to the stack for potential processing. We
              // optimistically add potential dirs here to simplify the async nature of fs calls.
            } else if (file.indexOf('.') === -1) {
              stack.push(fullpath);
            }
          });
          return next();
        });
      });
    }
  }
  next();
}

/**
 * Compiles all soy files from an input directory, but takes an emitter to use
 * instead of a callback.
 * @see compileTemplates for the emitter API.
 * @param {string} inputDir
 * @param {EventEmitter} emitter
 * @private
 */
SoyCompiler.prototype._compileTemplatesAndEmit = function(inputDir, emitter) {
  const self = this;
  findFiles(inputDir, 'soy', (err, files) => {
    if (err) return emitCompile(emitter, err);
    if (files.length === 0) return emitCompile(emitter);

    const outputDir = self._createOutputDir();
    return self
      ._maybeUsePrecompiledFiles(outputDir, files)
      .then(dirtyFiles => {
        self._maybeSetupDynamicRecompile(inputDir, outputDir, files, emitter);
        return self._compileTemplateFilesAndEmit(
          inputDir,
          outputDir,
          files,
          dirtyFiles,
          emitter
        );
      })
      .done()
      .catch(error => {
        throw error;
      });
  });
};

/**
 * Finalizes compile templates.
 * @param {EventEmitter} emitter
 * @private
 */
SoyCompiler.prototype._finalizeCompileTemplates = function(outputDir, emitter) {
  emitCompile(emitter);

  if (
    this._options.eraseTemporaryFiles &&
    !this._options.allowDynamicRecompile
  ) {
    exec(`rm -r '${outputDir}'`, {}, err => {
      // TODO(dan): This is a pretty nasty way to delete the files.  Maybe use rimraf
      if (err) console.error('soynode: Error deleting temporary files', err);
    });
  }
};

/**
 * Loads precompiled templates into memory.  All .soy.js files within the provided inputDir will be
 * loaded.
 * @param {string} inputDir
 * @param {function (Error, boolean)}
 */
SoyCompiler.prototype.loadCompiledTemplates = function(inputDir, callback) {
  const self = this;
  findFiles(inputDir, 'soy.js', (err, files) => {
    if (err) return callback(err, false);
    files = files.map(file => path.join(inputDir, file));
    return self.loadCompiledTemplateFiles(files, callback);
  });
};

/**
 * Loads an array of template files into memory.
 * @param {Array.<string>} files
 * @param {function (Error, boolean) | Object} callbackOrOptions
 * @param {function (Error, boolean)=} callback
 */
SoyCompiler.prototype.loadCompiledTemplateFiles = function(
  files,
  callbackOrOptions,
  callback
) {
  let vmType = DEFAULT_VM_CONTEXT;

  if (typeof callbackOrOptions === 'function') {
    callback = callbackOrOptions;
  } else {
    const { vmType: vmType2 } = callbackOrOptions;
    vmType = vmType2;
  }

  this.getSoyVmContext(vmType).loadCompiledTemplateFiles(files, callback);
};

/**
 * Adds a file system watch to the provided files, and executes the fn when changes are detected.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {Array.<string>} relativeFilePaths
 * @param {EventEmitter} emitter
 * @private
 */
SoyCompiler.prototype._maybeSetupDynamicRecompile = function(
  inputDir,
  outputDir,
  relativeFilePaths,
  emitter
) {
  if (!this._options.allowDynamicRecompile) {
    return;
  }

  let currentCompilePromise = Q.resolve(true);
  let dirtyFileSet = {};
  const self = this;
  relativeFilePaths.forEach(relativeFile => {
    const file = path.resolve(inputDir, relativeFile);
    if (self._watches[file]) return;
    try {
      self._watches[file] = Date.now();

      fs.watchFile(file, {}, () => {
        const now = Date.now();
        // Ignore spurious change events.
        console.log('soynode: caught change to ', file);
        if (now - self._watches[file] < 1000) return Q.resolve(true);

        dirtyFileSet[relativeFile] = true;
        self._watches[file] = now;

        // Wait until the previous compile has completed before starting a new one.
        currentCompilePromise = currentCompilePromise
          .then(() => {
            const dirtyFiles = Object.keys(dirtyFileSet);
            if (!dirtyFiles.length) {
              // Nothing needs to be recompiled because it was already caught by another job.
              return null;
            }
            dirtyFileSet = {};
            console.log(
              'soynode: Recompiling templates due to change in %s',
              dirtyFiles
            );
            return self._compileTemplateFilesAndEmit(
              inputDir,
              outputDir,
              relativeFilePaths,
              dirtyFiles,
              emitter
            );
          })
          .fail(err => {
            console.warn('soynode: Error recompiling ', err);
          });

        // Return the promise, for use when testing. fs.watchFile will just ignore this.
        return currentCompilePromise;
      });
    } catch (e) {
      console.warn(`soynode: Error watching ${file}`, e);
    }
  }, this);
};

/**
 * Checks if precompiled files are available, using them as necessary.
 * @param {string} outputDir
 * @param {Array.<string>} files
 * @return {Promise<Array.<string>>} Files that we could not find precompiled versions of.
 * @private
 */
SoyCompiler.prototype._maybeUsePrecompiledFiles = function(outputDir, files) {
  const { precompiledDir } = this._options;
  if (!precompiledDir) {
    return Q.resolve(files);
  }

  let vmTypes = [DEFAULT_VM_CONTEXT];
  const options = this._options;
  if (options.locales && options.locales.length > 0) {
    vmTypes = options.locales.concat(); // clone
  }

  const self = this;
  return Q.resolve(true)
    .then(() =>
      // Return an array of files that don't have precompiled versions.
      Q.all(
        files.map(file =>
          self
            ._preparePrecompiledFile(outputDir, precompiledDir, file, vmTypes)
            .then(ok => (ok ? '' : file))
        )
      )
    )
    .then(dirtyFiles => {
      dirtyFiles = dirtyFiles.filter(Boolean); // filter out empty strings.
      if (dirtyFiles.length !== files.length) {
        console.log(
          'Loaded %s precompiled files',
          files.length - dirtyFiles.length
        );
      }
      return dirtyFiles;
    })
    .fail(err => {
      console.error('Failed loading precompiled files', err);
      return files;
    });
};

/**
 * Checks if all locales of a file have been precompiled, and move them to the output directory.
 * @param {string} outputDir
 * @param {string} precompiledDir
 * @param {string} file
 * @param {Array<string>} vmTypes
 * @return {Promise<boolean>} True on success
 * @private
 */
SoyCompiler.prototype._preparePrecompiledFile = function(
  outputDir,
  precompiledDir,
  file,
  vmTypes
) {
  const self = this;
  const precompiledFilesOkPromise = Q.all(
    vmTypes.map(vmType => {
      const precompiledFileName = self._getOutputFile(
        precompiledDir,
        file,
        vmType
      );
      const outputFileName = self._getOutputFile(outputDir, file, vmType);

      const precompiledFileOkPromise = Q.nfcall(
        fs.stat,
        precompiledFileName
      ).then(
        exists => {
          if (!exists) {
            return false;
          }

          if (outputFileName !== precompiledFileName) {
            return Q.nfcall(fs.mkdirs, path.dirname(outputFileName))
              .then(() => Q.nfcall(copy, precompiledFileName, outputFileName))
              .then(() => true);
          }
          return true;
        },
        () => false // stat is expected to error out if the file isn't there.
      );
      return precompiledFileOkPromise;
    })
  );
  return precompiledFilesOkPromise.then(array => array.every(Boolean));
};

/**
 * Concatenates all output files into a single file.
 * @param {string} outputDir
 * @param {Array.<string>} files
 * @param {string=} vmType optional type of the vm
 * @private
 */
SoyCompiler.prototype._concatOutput = function(outputDir, files, vmType) {
  const options = this._options;
  let { concatFileName } = options;
  if (options.locales && options.locales.length > 1) {
    concatFileName += `_${vmType}`;
  }
  concatFileName += '.soy.concat.js';

  const target = path.join(outputDir, concatFileName);
  const concatenated = files
    .map(file => fs.readFileSync(file).toString())
    .join('');

  fs.writeFileSync(target, concatenated);
};

/**
 * @param {string} outputDir
 * @param {string} file
 * @param {string=} vmType
 */
SoyCompiler.prototype._getOutputFile = function(outputDir, file, vmType) {
  const options = this._options;
  vmType = vmType || DEFAULT_VM_CONTEXT;
  if (options.locales && options.locales.length > 1) {
    return `${path.join(outputDir, vmType, file)}.js`;
  }
  return `${path.join(outputDir, file)}.js`;
};

/**
 * Does all processing that happens after the compiling ends.
 * @param {string} outputDir
 * @param {Array.<string>} files
 * @param {string=} vmType optional type of the vm
 * @return {Promise}
 * @private
 */
SoyCompiler.prototype._postCompileProcess = function(outputDir, files, vmType) {
  const options = this._options;
  vmType = vmType || DEFAULT_VM_CONTEXT;

  // Build a list of paths that we expect as output of the soy compiler.
  const templatePaths = files.map(function(file) {
    return this._getOutputFile(outputDir, file, vmType);
  }, this);

  try {
    if (options.concatOutput)
      this._concatOutput(outputDir, templatePaths, vmType);
  } catch (e) {
    console.warn('soynode: Error concatenating files', e);
  }

  if (options.loadCompiledTemplates) {
    // Load the compiled templates into memory.
    return Q.nfcall(
      this.loadCompiledTemplateFiles.bind(this, templatePaths, { vmType })
    );
  }
  return Q.resolve(true);
};

export default SoyCompiler;