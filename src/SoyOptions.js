// @flow
// Copyright 2014. A Medium Corporation.

import path from 'path';

/**
 * Resolved path to the executable jar for the Closure Template compiler.
 * @type {string}
 */
const PATH_TO_SOY_JAR = require.resolve(
  'google-closure-templates/javascript/SoyToJsSrcCompiler.jar'
);

/**
 * Resolved path to Soy utils JS script.
 * @type {string}
 */
const PATH_TO_SOY_UTILS = require.resolve(
  'google-closure-templates/javascript/soyutils_usegoog.js'
);

/**
 * Describes the possible options set to a SoyCompiler.
 * @constructor
 */
export default class SoyOptions {
  $key: any;

  $value: any;

  tmpDir: string;

  inputDir: string;

  outputDir: ?string;

  precompiledDir: ?string;

  uniqueDir: boolean;

  allowDynamicRecompile: boolean;

  loadCompiledTemplates: boolean;

  eraseTemporaryFiles: boolean;

  useClosureStyle: boolean;

  shouldGenerateJsdoc: boolean;

  shouldProvideRequireSoyNamespaces: boolean;

  shouldProvideRequireJsFunctions: boolean;

  cssHandlingScheme: ?string;

  classpath: Array<string>;

  pluginModules: Array<string>;

  contextJsPaths: Array<string>;

  concatOutput: boolean;

  concatFileName: string;

  locales: Array<string>;

  messageFilePathFormat: ?string;

  shouldDeclareTopLevelNamespaces: boolean;

  protoFileDescriptors: string;

  soyJarPath: string;

  soyUtilsPath: string;

  /**
   * A temporary directory where compiled .soy.js files will be stored after compilation.
   * @type {string}
   */
  tmpDir = '/tmp/soynode';

  /**
   * Directory where the compiler will spawn compilation process.
   * When compiling from files defaults to process.cwd(), if compiling from a directory inputDir is used instead.
   * @type {string}
   */
  inputDir = process.cwd();

  /**
   * An output directory, which compiled soy.js files is stored.
   * @type {?string}
   */
  outputDir = null;

  /**
   * A directory of precompiled soy.js files. Soynode will check these first and
   * use them if available.
   *
   * You can set this to the same value as outputDir to re-use
   * results from previous runs.
   *
   * @type {?string}
   */
  precompiledDir = null;

  /**
   * Whether the compiled soy files should be placed into a unique directory(timestamped).
   * @type {boolean}
   */
  uniqueDir = true;

  /**
   * Whether to watch any files that are loaded and to refetch them when they change.
   * @type {boolean}
   */
  allowDynamicRecompile = false;

  /**
   * Whether or not to load the compiled templates in the VM context.
   * @type {boolean}
   */
  loadCompiledTemplates = true;

  /**
   * Whether to delete temporary files created during the compilation process.
   * @type {boolean}
   */
  eraseTemporaryFiles = false;

  /**
   * Whether or not to use goog.provide and goog.require for JS functions and Soy namespaces.
   * @type {boolean}
   */
  useClosureStyle = false;

  /**
   * Whether or not to generate JSDoc on each template function, with type info for the Closure Compiler.
   * @type {boolean}
   */
  shouldGenerateJsdoc = false;

  /**
   * Whether or not to use goog.provide and goog.require for JS functions and Soy namespaces.
   * If you set this flag, each generated JavaScript file contains:
   * - one goog.provide statement for the corresponding Soy file's namespace
   * - goog.require statements for the namespaces of the called template
   * @type {boolean}
   */
  shouldProvideRequireSoyNamespaces = false;

  /**
   * Whether or not to use goog.provide and goog.require for JS functions and Soy namespaces.
   * If you set this flag, each generated JS file contains:
   * - goog.provide statements for the full names of each of its template JS functions
   * - goog.require statements for the full names of each of the called templates.
   * @type {boolean}
   */
  shouldProvideRequireJsFunctions = false;

  /**
   * The scheme to use for handling 'css' commands. Specifying
   * 'literal' will cause command text to be inserted as literal
   * text. Specifying 'reference' will cause command text to be
   * evaluated as a data or global reference. Specifying 'goog'
   * will cause generation of calls goog.getCssName. This option
   * has no effect if the Soy code does not contain 'css'
   * commands.
   * @type {?string}
   */
  cssHandlingScheme = undefined;

  /**
   * Additional classpath to pass to the soy template compiler. This makes adding plugins possible.
   * @type {Array<string>}
   */
  classpath = [];

  /**
   * Plugin module Java classnames to pass to the soy template compiler.
   * @type {Array<string>}
   */
  pluginModules = [];

  /**
   * Additional JS files to be evaluated in the VM context for the soy templates.
   * Useful for soy function support libs
   * @type {Array<string>}
   */
  contextJsPaths = [];

  /**
   * Whether the compiled soy.js files should be joined into a single file
   * @type {boolean}
   */
  concatOutput = false;

  /**
   * File name used for concatenated files, only relevant when concatOutput is true.
   * @type {string}
   */
  concatFileName = 'compiled';

  /**
   * List of locales to translate the templates to.
   * @type {Array<string>}
   */
  locales = [];

  /**
   * Path to the translation file to use, which can contain any of the placeholders
   * allowed on the --messageFilePathFormat option of SoyToJsSrcCompiler.jar.
   * @type {?string}
   */
  messageFilePathFormat = null;

  /**
   * When this option is set to false, each generated JS file
   * will not attempt to declare the top-level name in its
   * namespace, instead assuming the top-level name is already
   * declared in the global scope. E.g. for namespace aaa.bbb,
   * the code will not attempt to declare aaa, but will still
   * define aaa.bbb if it's not already defined.
   * @type {boolean}
   */
  shouldDeclareTopLevelNamespaces = true;

  /**
   * Points to a directory with proto files
   * @type {string}
   */
  protoFileDescriptors = '';

  soyJarPath = PATH_TO_SOY_JAR;

  soyUtilsPath = PATH_TO_SOY_UTILS;

  /**
   * Sets options which affect how soynode operates.
   */
  merge = (opts: Object = {}) => {
    const { tmpDir, outputDir, ...otherOpts } = opts;

    // When setting the tmpDir make sure to resolve the absolute path so as to avoid accidents
    // caused by changes to the working directory.
    if (tmpDir) this.tmpDir = path.resolve(tmpDir);

    if (outputDir) this.outputDir = path.resolve(opts.outputDir);

    Object.keys(otherOpts).forEach(key => {
      const isFunction = typeof this[key] === 'function';
      if (isFunction && this[key] === opts[key]) {
        return;
      }

      if (!(key in this) || typeof this[key] === 'function') {
        throw new Error(`soynode: Invalid option key [${key}]`);
      }

      this[key] = opts[key];
    });
  };
}
