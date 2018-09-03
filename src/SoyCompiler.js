// @flow
// Copyright 2014. A Medium Corporation.

import EventEmitter from 'events';
import childProcess from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import rimraf from 'rimraf';
import SoyVmContext from './SoyVmContext';
import SoyOptions from './SoyOptions';

/**
 * The key in vmContexts for the default vm context (with no locale).
 */
const DEFAULT_VM_CONTEXT = 'default';

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

async function clean(outputDir: string): Promise<void> {
  try {
    await promisify(rimraf)(outputDir);
  } catch (err) {
    console.error('soynode: Error deleting temporary files', err);
  }
}

/**
 * Performs a recursive directory traversal of the given directory, accumulating all files with the
 * provided extension.  The resultant array is a list of paths relative to the input directory.
 * @param {string} directory
 * @param {string} extension
 */
async function findFiles(
  directory: string,
  extension: string
): Promise<Array<string>> {
  const files = [];
  const stack = [directory];

  async function next(): Promise<Array<string>> {
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
  _options: Object;

  _defaultOptions: SoyOptions;

  constructor(options: SoyOptions) {
    this._options = this._defaultOptions;
    this.setOptions(options);
  }

  _defaultOptions = new SoyOptions();
  /** @private {SoyOptions} */

  /**
   * VM Context that is used as the global when fetching templates.  The end result is that this
   * object contains references to the JS functions rendered by Soy.
   * @type {Object.<string, SoyVmContext>}
   */
  _vmContexts = {};

  /**
   * Map of filenames that have a watch to the last time it was called.
   * @param {Object.<number>}
   */
  _watches = {};

  /** @return {SoyOptions} */
  getDefaultOptions = (): SoyOptions => this._defaultOptions;

  /**
   * Sets options which affect how soynode operates.
   * @param {{
   *     tmpDir: string=, //Deprecated
   *     outputDir: string=,
   *     uniqueDir: boolean=,
   *     allowDynamicRecompile: boolean=,
   *     eraseTemporaryFiles: boolean=}}} opts
   */
  setOptions = (opts: Object) => {
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
  get = (templateName: string, vmType: ?string): ((...any) => string) =>
    this.getSoyVmContext(vmType).get(templateName);

  /**
   * Renders a template using the provided data and returns the resultant string.
   * @param {string} templateName
   * @param {Object=} data
   * @param {Object=} injectedData optional injected data available via $ij
   * @param {string=} vmType optional type of the vm
   * @return {string}
   */
  render = (
    templateName: string,
    data: ?Object,
    injectedData: ?Object,
    vmType: string
  ): string =>
    // Certain autoescape modes of closure-templates return a Content object
    // instead of a string, so force a string.
    String(this.get(templateName, vmType)(data, null, injectedData));

  /**
   * Gets the SoyVmContext object for the for the given locale, or the default if no locale is given.
   *
   * @param {string=} vmType optional type of the vm
   */
  getSoyVmContext = (vmType: ?string) => {
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
  getVMContext = (vmType: string) => this.getSoyVmContext(vmType).getContext();

  /**
   * Compiles all soy files within the provided directory and loads them into memory.
   * @param {string} inputDir
   */
  compileTemplates = async (inputDir: string): Promise<void> => {
    const emitter = new EventEmitter();
    this._compileTemplatesAndEmit(inputDir, emitter);
    await promisify(emitter.once).bind(emitter)('compile');
  };

  /**
   * Compiles all soy files within the provided array and loads them into memory.
   * @param {Array.<string>} files
   * @return {Promise}
   */
  compileTemplateFiles = async (files: Array<string>): Promise<void> => {
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

    await promisify(emitter.once).bind(emitter)('compile');
  };

  /**
   * Resolves the output directory from the current options.
   * @return {string}
   * @private
   */
  _createOutputDir = (): string => {
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
  _compileTemplateFilesAndEmit = async (
    inputDir: string,
    outputDir: string,
    allFiles: Array<string>,
    dirtyFiles: Array<string>,
    emitter: EventEmitter
  ) => {
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
  _compileTemplateFilesAsync = async (
    inputDir: string,
    outputDir: string,
    allFiles: Array<string>,
    dirtyFiles: Array<string>
  ): Promise<void> => {
    const options = this._options;
    let outputPathFormat = path.join(
      outputDir,
      '{INPUT_DIRECTORY}',
      '{INPUT_FILE_NAME}.js'
    );

    // Arguments for running the soy compiler via java.
    let args = [
      '-classpath',
      [options.soyJarPath].concat(options.classpath).join(path.delimiter),
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

    async function runCompiler(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!dirtyFiles.length) {
          resolve();
          return;
        }

        let stderr = '';

        function onExit(exitCode) {
          if (terminated) return;

          if (exitCode !== 0) {
            // Log all the errors and execute the callback with a generic error object.
            terminated = true;
            console.error('soynode: Compile error\n', stderr);
            reject(new Error('Error compiling templates'));
            return;
          }
          resolve();
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
      });
    }

    await runCompiler();
    let vmTypes = [DEFAULT_VM_CONTEXT];
    if (options.locales && options.locales.length > 0) {
      vmTypes = [...options.locales]; // clone
    }

    const next = async (): Promise<boolean> => {
      if (vmTypes.length === 0) {
        return true;
      }
      await this._postCompileProcess(outputDir, allFiles, vmTypes.pop());
      return next();
    };

    await next();
  };

  /**
   * Compiles all soy files from an input directory, but takes an emitter to use
   * instead of a callback.
   * @see compileTemplates for the emitter API.
   * @param {string} inputDir
   * @param {EventEmitter} emitter
   * @private
   */
  _compileTemplatesAndEmit = async (
    inputDir: string,
    emitter: EventEmitter
  ) => {
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
  };

  /**
   * Finalizes compile templates.
   * @param {EventEmitter} emitter
   * @private
   */
  _finalizeCompileTemplates = (outputDir: string, emitter: EventEmitter) => {
    emitCompile(emitter);

    if (
      this._options.eraseTemporaryFiles &&
      !this._options.allowDynamicRecompile
    ) {
      clean(outputDir);
    }
  };

  /**
   * Loads precompiled templates into memory.  All .soy.js files within the provided inputDir will be
   * loaded.
   * @param {string} inputDir
   */
  loadCompiledTemplates = async (inputDir: string) => {
    const files = await findFiles(inputDir, 'soy.js');
    const filesMapping = files.map(file => path.join(inputDir, file));
    return this.loadCompiledTemplateFiles(filesMapping);
  };

  /**
   * Loads an array of template files into memory.
   * @param {Array.<string>} files
   * @param {Object} options
   */
  loadCompiledTemplateFiles = async (
    files: Array<string>,
    options: Object = {}
  ) => {
    const { vmType } = options;

    const soyVmContext = this.getSoyVmContext(vmType);
    return soyVmContext.loadCompiledTemplateFiles(files);
  };

  /**
   * Adds a file system watch to the provided files, and executes the fn when changes are detected.
   * @param {string} inputDir
   * @param {string} outputDir
   * @param {Array.<string>} relativeFilePaths
   * @param {EventEmitter} emitter
   * @private
   */
  _maybeSetupDynamicRecompile = (
    inputDir: string,
    outputDir: string,
    relativeFilePaths: Array<string>,
    emitter: EventEmitter
  ) => {
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
  };

  /**
   * Checks if precompiled files are available, using them as necessary.
   * @param {string} outputDir
   * @param {Array.<string>} files
   * @return {Promise<Array.<string>>} Files that we could not find precompiled versions of.
   * @private
   */
  _maybeUsePrecompiledFiles = async (
    outputDir: string,
    files: Array<string>
  ) => {
    const { precompiledDir } = this._options;
    if (!precompiledDir) {
      return files;
    }

    let vmTypes = [DEFAULT_VM_CONTEXT];
    const options = this._options;
    if (options.locales && options.locales.length > 0) {
      vmTypes = options.locales.concat(); // clone
    }

    try {
      const filesMapping = files.map(async file => {
        const ok = await this._preparePrecompiledFile(
          outputDir,
          precompiledDir,
          file,
          vmTypes
        );
        return ok ? '' : file;
      });

      // Return an array of files that don't have precompiled versions.
      const dirtyFiles = (await Promise.all(filesMapping)).filter(Boolean); // filter out empty strings.

      if (dirtyFiles.length !== files.length) {
        console.log(
          'Loaded %s precompiled files',
          files.length - dirtyFiles.length
        );
      }

      return dirtyFiles;
    } catch (err) {
      console.error('Failed loading precompiled files', err);
      return files;
    }
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
  _preparePrecompiledFile = async (
    outputDir: string,
    precompiledDir: string,
    file: string,
    vmTypes: Array<string>
  ) => {
    const vmTypesMapping = vmTypes.map(async vmType => {
      const precompiledFileName = this._getOutputFile(
        precompiledDir,
        file,
        vmType
      );

      const outputFileName = this._getOutputFile(outputDir, file, vmType);

      let exists;
      try {
        exists = await promisify(fs.stat)(precompiledFileName);
      } catch (err) {
        exists = false;
      }

      if (!exists) {
        return false;
      }

      if (outputFileName !== precompiledFileName) {
        await promisify(fs.mkdirs)(path.dirname(outputFileName));
        await promisify(fs.copy)(precompiledFileName, outputFileName);
      }
      return true;
    });

    const array = await Promise.all(vmTypesMapping);
    return array.every(Boolean);
  };

  /**
   * Concatenates all output files into a single file.
   * @param {string} outputDir
   * @param {Array.<string>} files
   * @param {string=} vmType optional type of the vm
   * @private
   */
  _concatOutput = (outputDir: string, files: Array<string>, vmType: string) => {
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
  _getOutputFile = (
    outputDir: string,
    file: string,
    vmType: string = DEFAULT_VM_CONTEXT
  ) => {
    const options = this._options;
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
  _postCompileProcess = async (
    outputDir: string,
    files: Array<string>,
    vmType: string = DEFAULT_VM_CONTEXT
  ) => {
    const options = this._options;

    // Build a list of paths that we expect as output of the soy compiler.
    const templatePaths = files.map(file =>
      this._getOutputFile(outputDir, file, vmType)
    );

    try {
      if (options.concatOutput)
        this._concatOutput(outputDir, templatePaths, vmType);
    } catch (e) {
      console.warn('soynode: Error concatenating files', e);
    }

    if (options.loadCompiledTemplates) {
      // Load the compiled templates into memory.
      return this.loadCompiledTemplateFiles(templatePaths, { vmType });
    }
    return true;
  };
}
