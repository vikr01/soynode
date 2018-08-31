// Copyright 2014. A Medium Corporation.

import { EventEmitter } from 'events';
import childProcess, { exec } from 'child_process';
import closureTemplates from 'closure-templates';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
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
 * Performs a recursive directory traversal of the given directory, accumulating all files with the
 * provided extension.  The resultant array is a list of paths relative to the input directory.
 * @param {string} directory
 * @param {string} extension
 */
async function findFiles(directory, extension) {
  const files = [];
  const stack = [directory];

  async function next() {
    if (stack.length === 0) {
      return files;
    }
    const dir = stack.pop();
    const stats = await promisify(fs.stat)(dir);

    if (!stats.isDirectory()) return next();

    const dirContents = await promisify(fs.readdir)(dir);

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
  }
  return next();
}

/**
 * The main public API of soynode.
 * @constructor
 */
export default class SoyCompiler {
  constructor() {
    this._defaultOptions = new SoyOptions();

    /** @private {SoyOptions} */
    this._options = this._defaultOptions;

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
  getDefaultOptions() {
    return this._defaultOptions;
  }

  /**
   * Sets options which affect how soynode operates.
   * @param {{
   *     tmpDir: string=, //Deprecated
   *     outputDir: string=,
   *     uniqueDir: boolean=,
   *     allowDynamicRecompile: boolean=,
   *     eraseTemporaryFiles: boolean=}}} opts
   */
  setOptions(opts) {
    this._options.merge(opts);
  }

  /**
   * Gets a reference to a template function.
   *
   * Note: If dynamic recompilation is enabled the reference will not get updated.
   *
   * @param {string} templateName
   * @param {string=} vmType optional type of the vm
   * @return {function (Object) : string}
   */
  get(templateName, vmType) {
    return this.getSoyVmContext(vmType || DEFAULT_VM_CONTEXT).get(templateName);
  }

  /**
   * Renders a template using the provided data and returns the resultant string.
   * @param {string} templateName
   * @param {Object=} data
   * @param {Object=} injectedData optional injected data available via $ij
   * @param {string=} vmType optional type of the vm
   * @return {string}
   */
  render(templateName, data, injectedData, vmType) {
    // Certain autoescape modes of closure-templates return a Content object
    // instead of a string, so force a string.
    return String(this.get(templateName, vmType)(data, null, injectedData));
  }

  /**
   * Gets the SoyVmContext object for the for the given locale, or the default if no locale is given.
   *
   * @param {string=} vmType optional type of the vm
   */
  getSoyVmContext(vmType) {
    vmType = vmType || DEFAULT_VM_CONTEXT;

    if (!this._vmContexts[vmType]) {
      this._vmContexts[vmType] = new SoyVmContext(vmType, this._options);
    }

    return this._vmContexts[vmType];
  }

  /**
   * Gets the vm context for the given locale, or the default if no locale is given.
   *
   * @param {string=} vmType optional type of the vm
   * @return {Object}
   */
  getVMContext(vmType) {
    return this.getSoyVmContext(vmType).getContext();
  }

  /**
   * Compiles all soy files within the provided directory and loads them into memory.  The callback
   * will be called when templates are ready, or an error occurred along the way.
   * @param {string} inputDir
   * @param {function (Error, boolean)=} callback
   * @return {EventEmitter} An EventEmitter that publishes a "compile" event after every compile
   *     This is particularly useful if you have allowDynamicRecompile on, so that your server
   *     can propagate the error appropriately. The "compile" event has two arguments: (error, success).
   */
  compileTemplates(inputDir, callback) {
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
  }

  /**
   * Compiles all soy files within the provided array and loads them into memory.  The callback
   * will be called when templates are ready, or an error occurred along the way.
   * @param {Array.<string>} files
   * @param {function (Error, boolean)=} callback
   * @return {EventEmitter} An EventEmitter that publishes a "compile" event after every compile.
   */
  async compileTemplateFiles(files) {
    const emitter = new EventEmitter();
    const outputDir = this._createOutputDir();
    const { inputDir } = this._options;
    const dirtyFiles = await this._maybeUsePrecompiledFiles(outputDir, files);
    this._maybeSetupDynamicRecompile(inputDir, outputDir, files, emitter);
    this._compileTemplateFilesAndEmit(
      inputDir,
      outputDir,
      files,
      dirtyFiles,
      emitter
    );

    return promisify(emitter.once).bind(emitter)('compile');
  }

  /**
   * Resolves the output directory from the current options.
   * @return {string}
   * @private
   */
  _createOutputDir() {
    const options = this._options;
    let dir = options.outputDir || options.tmpDir;
    if (options.uniqueDir !== false) {
      const timeDirectory = new Date().toISOString().replace(/:/g, '_');
      dir = path.join(dir, timeDirectory);
    }
    return dir;
  }

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
  async _compileTemplateFilesAndEmit(
    inputDir,
    outputDir,
    allFiles,
    dirtyFiles,
    emitter
  ) {
    try {
      await this._compileTemplateFilesAsync(
        inputDir,
        outputDir,
        allFiles,
        dirtyFiles
      );
    } catch (err) {
      return emitCompile(emitter, err);
    }

    return this._finalizeCompileTemplates(outputDir, emitter);
  }

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
  async _compileTemplateFilesAsync(inputDir, outputDir, allFiles, dirtyFiles) {
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

    async function runCompiler() {
      return new Promise((resolve, reject) => {
        if (!dirtyFiles.length) {
          return resolve(true);
        }

        let stderr = '';

        function onExit(exitCode) {
          if (terminated) return null;

          if (exitCode !== 0) {
            // Log all the errors and execute the callback with a generic error object.
            terminated = true;
            console.error('soynode: Compile error\n', stderr);
            return reject(new Error('Error compiling templates'));
          }
          return resolve(true);
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
        return null;
      });
    }

    await runCompiler();
    let vmTypes = [DEFAULT_VM_CONTEXT];
    if (options.locales && options.locales.length > 0) {
      vmTypes = [...options.locales]; // clone
    }

    const next = async () => {
      if (vmTypes.length === 0) {
        return Promise.resolve(true);
      }
      await this._postCompileProcess(outputDir, allFiles, vmTypes.pop());
      return next();
    };

    return next();
  }

  /**
   * Compiles all soy files from an input directory, but takes an emitter to use
   * instead of a callback.
   * @see compileTemplates for the emitter API.
   * @param {string} inputDir
   * @param {EventEmitter} emitter
   * @private
   */
  async _compileTemplatesAndEmit(inputDir, emitter) {
    let files;
    try {
      files = await findFiles(inputDir, 'soy');
    } catch (err) {
      return emitCompile(emitter, err);
    }

    if (files.length === 0) return emitCompile(emitter);
    const outputDir = this._createOutputDir();
    const dirtyFiles = await this._maybeUsePrecompiledFiles(outputDir, files);
    this._maybeSetupDynamicRecompile(inputDir, outputDir, files, emitter);
    return this._compileTemplateFilesAndEmit(
      inputDir,
      outputDir,
      files,
      dirtyFiles,
      emitter
    );
  }

  /**
   * Finalizes compile templates.
   * @param {EventEmitter} emitter
   * @private
   */
  _finalizeCompileTemplates(outputDir, emitter) {
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
  }

  /**
   * Loads precompiled templates into memory.  All .soy.js files within the provided inputDir will be
   * loaded.
   * @param {string} inputDir
   * @param {function (Error, boolean)}
   */
  loadCompiledTemplates(inputDir, callback) {
    findFiles(inputDir, 'soy.js', (err, files) => {
      if (err) return callback(err, false);
      files = files.map(file => path.join(inputDir, file));
      return this.loadCompiledTemplateFiles(files, callback);
    });
  }

  /**
   * Loads an array of template files into memory.
   * @param {Array.<string>} files
   * @param {function (Error, boolean) | Object} callbackOrOptions
   * @param {function (Error, boolean)=} callback
   */
  loadCompiledTemplateFiles(files, callbackOrOptions, callback) {
    let vmType = DEFAULT_VM_CONTEXT;

    if (typeof callbackOrOptions === 'function') {
      callback = callbackOrOptions;
    } else {
      const { vmType: vmType2 } = callbackOrOptions;
      vmType = vmType2;
    }

    this.getSoyVmContext(vmType).loadCompiledTemplateFiles(files, callback);
  }

  /**
   * Adds a file system watch to the provided files, and executes the fn when changes are detected.
   * @param {string} inputDir
   * @param {string} outputDir
   * @param {Array.<string>} relativeFilePaths
   * @param {EventEmitter} emitter
   * @private
   */
  _maybeSetupDynamicRecompile(inputDir, outputDir, relativeFilePaths, emitter) {
    if (!this._options.allowDynamicRecompile) {
      return;
    }

    let currentCompilePromise = Promise.resolve(true);
    let dirtyFileSet = {};
    relativeFilePaths.forEach(async relativeFile => {
      const file = path.resolve(inputDir, relativeFile);
      if (this._watches[file]) return;

      try {
        this._watches[file] = Date.now();

        fs.watchFile(file, {}, async () => {
          const now = Date.now();
          // Ignore spurious change events.
          console.log('soynode: caught change to ', file);
          if (now - this._watches[file] < 1000) return true;

          dirtyFileSet[relativeFile] = true;
          this._watches[file] = now;

          // Wait until the previous compile has completed before starting a new one.
          try {
            await currentCompilePromise;
          } catch (err) {
            console.warn('soynode: Error recompiling ', err);
            return undefined;
          }

          const dirtyFiles = Object.keys(dirtyFileSet);
          if (!dirtyFiles.length) {
            // Nothing needs to be recompiled because it was already caught by another job.
            currentCompilePromise = Promise.resolve(null);
            return undefined;
          }
          dirtyFileSet = {};
          console.log(
            'soynode: Recompiling templates due to change in %s',
            dirtyFiles
          );

          currentCompilePromise = this._compileTemplateFilesAndEmit(
            inputDir,
            outputDir,
            relativeFilePaths,
            dirtyFiles,
            emitter
          );

          return currentCompilePromise;
        });

        // Return the promise, for use when testing. fs.watchFile will just ignore this.
      } catch (e) {
        console.warn(`soynode: Error watching ${file}`, e);
      }
    });
  }

  /**
   * Checks if precompiled files are available, using them as necessary.
   * @param {string} outputDir
   * @param {Array.<string>} files
   * @return {Promise<Array.<string>>} Files that we could not find precompiled versions of.
   * @private
   */
  _maybeUsePrecompiledFiles(outputDir, files) {
    const { precompiledDir } = this._options;
    if (!precompiledDir) {
      return Promise.resolve(files);
    }

    let vmTypes = [DEFAULT_VM_CONTEXT];
    const options = this._options;
    if (options.locales && options.locales.length > 0) {
      vmTypes = options.locales.concat(); // clone
    }

    return Promise.resolve(true)
      .then(() =>
        // Return an array of files that don't have precompiled versions.
        Promise.all(
          files.map(file =>
            this._preparePrecompiledFile(
              outputDir,
              precompiledDir,
              file,
              vmTypes
            ).then(ok => (ok ? '' : file))
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
      .catch(err => {
        console.error('Failed loading precompiled files', err);
        return files;
      });
  }

  /**
   * Checks if all locales of a file have been precompiled, and move them to the output directory.
   * @param {string} outputDir
   * @param {string} precompiledDir
   * @param {string} file
   * @param {Array<string>} vmTypes
   * @return {Promise<boolean>} True on success
   * @private
   */
  _preparePrecompiledFile(outputDir, precompiledDir, file, vmTypes) {
    const precompiledFilesOkPromise = Promise.all(
      vmTypes.map(vmType => {
        const precompiledFileName = this._getOutputFile(
          precompiledDir,
          file,
          vmType
        );
        const outputFileName = this._getOutputFile(outputDir, file, vmType);

        const precompiledFileOkPromise = promisify(fs.stat)(
          precompiledFileName
        ).then(
          exists => {
            if (!exists) {
              return false;
            }

            if (outputFileName !== precompiledFileName) {
              return promisify(fs.mkdirs)(path.dirname(outputFileName))
                .then(() =>
                  promisify(copy)(precompiledFileName, outputFileName)
                )
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
  }

  /**
   * Concatenates all output files into a single file.
   * @param {string} outputDir
   * @param {Array.<string>} files
   * @param {string=} vmType optional type of the vm
   * @private
   */
  _concatOutput(outputDir, files, vmType) {
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
  }

  /**
   * @param {string} outputDir
   * @param {string} file
   * @param {string=} vmType
   */
  _getOutputFile(outputDir, file, vmType) {
    const options = this._options;
    vmType = vmType || DEFAULT_VM_CONTEXT;
    if (options.locales && options.locales.length > 1) {
      return `${path.join(outputDir, vmType, file)}.js`;
    }
    return `${path.join(outputDir, file)}.js`;
  }

  /**
   * Does all processing that happens after the compiling ends.
   * @param {string} outputDir
   * @param {Array.<string>} files
   * @param {string=} vmType optional type of the vm
   * @return {Promise}
   * @private
   */
  _postCompileProcess(outputDir, files, vmType) {
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
      return promisify(
        this.loadCompiledTemplateFiles.bind(this, templatePaths, { vmType })
      )();
    }
    return Promise.resolve(true);
  }
}
