// Copyright 2014. A Medium Corporation.

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import closureTemplates from 'closure-templates';
import { promisify } from 'util';

/**
 * Resolved path to Soy utils JS script.
 * @type {string}
 */
const SOY_UTILS_PATH = closureTemplates['soyutils_usegoog.js'];

/**
 * All the dependencies of soyutils_usegoog.js
 *
 * In theory, it'd be more robust to load these with goog.require
 * but I haven't figured out how to make the bootstrapping work
 * in the VM environment.
 */
const CLOSURE_PATHS = [
  'closure/goog/base.js',
  'closure/goog/deps.js',
  'closure/goog/debug/error.js',
  'closure/goog/dom/nodetype.js',
  'closure/goog/string/string.js',
  'closure/goog/asserts/asserts.js',
  'closure/goog/array/array.js',
  'closure/goog/dom/tagname.js',
  'closure/goog/object/object.js',
  'closure/goog/dom/tags.js',
  'closure/goog/string/typedstring.js',
  'closure/goog/string/const.js',
  'closure/goog/html/safestyle.js',
  'closure/goog/html/safestylesheet.js',
  'closure/goog/fs/url.js',
  'closure/goog/i18n/bidi.js',
  'closure/goog/html/safeurl.js',
  'closure/goog/html/trustedresourceurl.js',
  'closure/goog/html/safehtml.js',
  'closure/goog/html/safescript.js',
  'closure/goog/html/uncheckedconversions.js',
  'closure/goog/structs/structs.js',
  'closure/goog/structs/collection.js',
  'closure/goog/functions/functions.js',
  'closure/goog/math/math.js',
  'closure/goog/iter/iter.js',
  'closure/goog/structs/map.js',
  'closure/goog/structs/set.js',
  'closure/goog/labs/useragent/util.js',
  'closure/goog/labs/useragent/browser.js',
  'closure/goog/labs/useragent/engine.js',
  'closure/goog/labs/useragent/platform.js',
  'closure/goog/useragent/useragent.js',
  'closure/goog/debug/debug.js',
  'closure/goog/dom/browserfeature.js',
  'closure/goog/dom/safe.js',
  'closure/goog/math/coordinate.js',
  'closure/goog/math/size.js',
  'closure/goog/dom/dom.js',
  'closure/goog/structs/inversionmap.js',
  'closure/goog/i18n/graphemebreak.js',
  'closure/goog/format/format.js',
  'closure/goog/html/legacyconversions.js',
  'closure/goog/i18n/bidiformatter.js',
  'closure/goog/soy/data.js',
  'closure/goog/soy/soy.js',
  'closure/goog/string/stringbuffer.js',
].map(file =>
  path.join(require.resolve('google-closure-library/package.json'), '..', file)
);

function pathsToPromises(paths) {
  return paths.map(async pathToPromise => {
    const contents = await promisify(fs.readFile)(pathToPromise, 'utf8');
    return {
      path: pathToPromise,
      contents,
    };
  });
}

let supportFilePromises = null;

/**
 * @return {Array.<Promise.<string>>} Promises for the file contents of closure/soy support code.
 */
function getSupportFilePromises(soyUtilsPath) {
  if (supportFilePromises) return supportFilePromises;

  soyUtilsPath = soyUtilsPath || SOY_UTILS_PATH;

  const paths = CLOSURE_PATHS.concat([soyUtilsPath]);
  supportFilePromises = pathsToPromises(paths);
  return supportFilePromises;
}

/**
 * Closure-templates keeps a global registry of all deltemplates.
 * We want to be able to reset the registry when we recompile.
 *
 * This is kind of a terrible solution, but it seems faster and more
 * robust than trying to reload all the support code every time.
 */
const RESET_DELTEMPLATE_REGISTRY_CODE =
  'soy.$$DELEGATE_REGISTRY_PRIORITIES_ = {};\n' +
  'soy.$$DELEGATE_REGISTRY_FUNCTIONS_ = {};';

/**
 * @param {VmContext} context a vm context
 * @param {Array.<Promise>} filePromises Promises of {path, contents} tuples
 * @return {Promise.Promise}
 */
async function loadFiles(context, filePromises) {
  let i = 0;

  async function next(result) {
    // Evaluate the template code in the context of the soy VM context.  Any variables defined
    // in the template file will become members of the vmContext object.
    vm.runInContext(result.contents, context, result.path);

    if (i >= filePromises.length) {
      return true;
    }
    const nextResult = await filePromises[i++];
    return next(nextResult);
  }

  if (!filePromises.length) {
    return true;
  }
  const result = await filePromises[i++];
  return next(result);
}

/**
 * An abstract API over a soynode VM context.
 *
 * SoyNode operates by creating a VM sandbox, and loading the soy functions into
 * that sandbox. If you use SoyNode's i18n features, you may have multiple sandboxes,
 * one for each locale.
 *
 * @param {string} name
 * @param {SoyOptions} options
 * @constructor
 */
export default class SoyVmContext {
  constructor(name, options) {
    /** @private {string} */
    this._name = name;

    /** @private {SoyOptions} */
    this._options = options;

    /**
     * A cache for function pointers returned by the vm.runInContext call.  Caching the reference
     * results in a 10x speed improvement, over calling getting the function each time.
     * @type {Object}
     */
    this._templateCache = {};

    this._context = vm.createContext({});

    /** @private {boolean} Whether the context has been initialized with soyutils */
    this._contextInitialized = false;
  }

  /**
   * The unique name of the sandbox.
   * @return {string}
   */
  getName() {
    return this._name;
  }

  /**
   * @return {Object} Get the internal vm context. Useful for injecting globals
   *     manually into the context.
   * @return {Object}
   */
  getContext() {
    return this._context;
  }

  /**
   * @param {Object} context Sets the context. Useful for injecting globals
   *     manually into the context, but beware of overwriting the soy support code.
   */
  setContext(context) {
    this._context = context;
  }

  /**
   * Gets a reference to a template function.
   *
   * Note: If dynamic recompilation is enabled the reference will not get updated.
   *
   * @param {string} templateName
   * @return {function (Object) : string}
   */
  get(templateName) {
    if (!this._options.loadCompiledTemplates)
      throw new Error(
        'soynode: Cannot load template, try with `loadCompiledTemplates: true`.'
      );

    if (!this._templateCache[templateName]) {
      let template;
      try {
        template = vm.runInContext(
          templateName,
          this.getContext(),
          'soynode.vm'
        );
      } catch (e) {
        // Fallthrough
      }

      if (!template)
        throw new Error(`soynode: Unknown template [${templateName}]`);
      this._templateCache[templateName] = template;
    }
    return this._templateCache[templateName];
  }

  /**
   * Loads an array of template files into memory.
   * @param {Array.<string>} files
   * @param {function (Error, boolean)=} callback
   */
  loadCompiledTemplateFiles(files, callback) {
    const options = this._options;

    // load the contextJsPaths into the context before the soy template JS
    const filePromises = pathsToPromises(options.contextJsPaths.concat(files));
    const supportedFilePromises = getSupportFilePromises(options.soyUtilsPath);

    let result = Promise.resolve(true);
    if (this._contextInitialized) {
      result = (async () => {
        vm.runInContext(
          RESET_DELTEMPLATE_REGISTRY_CODE,
          this.getContext(),
          'soynode-reset.'
        );
      })();
    } else {
      result = result
        .then(() => loadFiles(this.getContext(), supportedFilePromises))
        .then(() => {
          this._contextInitialized = true;
          return null;
        });
    }

    result
      .then(() => loadFiles(this.getContext(), filePromises))
      .then(
        finalResult => {
          // Blow away the cache when all files have been loaded
          this._templateCache = {};
          return callback(null, finalResult);
        },
        err => callback(err)
      )
      .catch(err => callback(err));
  }
}
