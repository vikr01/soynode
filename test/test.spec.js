import child_process from 'child_process';
import fs, { watchFile } from 'fs-extra';
import path from 'path';
import delay from 'delay';
import { promisify } from 'util';
import { SoyCompiler } from '../src/soynode';

const { now } = Date;
const { spawn } = child_process;
const assetsPath = path.join(__dirname, 'assets');
const tmpPath = '/tmp/soynode';

let watchFiles;
let watchCallbacks;
let spawnOpts;
let spawnArgs;
let time;
let soyCompiler;
const tmpDirs = {
  tmp1: path.join(__dirname, 'tmp1'),
  tmp2: path.join(__dirname, 'tmp2'),
};

const assertTemplatesContents = (locale, opt_soyCompiler) => {
  const underTest = opt_soyCompiler || soyCompiler;
  const template1 = underTest.render(
    'template1.formletter',
    { title: 'Mr.', surname: 'Pupius' },
    null,
    locale
  );
  const template2 = underTest.render(
    'template2.formletter',
    { title: 'Mr.', surname: 'Santos' },
    null,
    locale
  );

  expect(typeof template1).toEqual('string');
  expect(typeof template2).toEqual('string');

  switch (locale) {
    case 'pt-BR':
      expect(template1).toEqual(
        'Querido Mr. Pupius: Com um nome como Mr. Pupius, você não deveria ter o seu própro tema musical? Nós podemos ajudar!'
      );
      expect(template2).toEqual(
        'Querido Mr. Santos: Com um nome como Mr. Santos, você não deveria ter o seu própro tema musical? Nós podemos ajudar!'
      );
      break;
    case 'es':
      expect(template1).toEqual(
        'Estimado Mr. Pupius: Con un nombre como Mr. Pupius, ¿no debería tener su propia canción? Nosotros podemos ayudarle!'
      );
      expect(template2).toEqual(
        'Estimado Mr. Santos: Con un nombre como Mr. Santos, ¿no debería tener su propia canción? Nosotros podemos ayudarle!'
      );
      break;
    default:
      expect(template1).toEqual(
        "Dear Mr. Pupius: With a name like Mr. Pupius, shouldn't you have your own theme song? We can help!"
      );
      expect(template2).toEqual(
        "Dear Mr. Santos: With a name like Mr. Santos, shouldn't you have your own theme song? We can help!"
      );
      break;
  }
};

beforeEach(() => {
  soyCompiler = new SoyCompiler();

  time = 1;
  Date.now = () => time;

  watchFiles = [];
  watchCallbacks = [];
  fs.watchFile = (f, opts, callback) => {
    watchFiles.push(f);
    watchCallbacks.push(callback);
  };

  spawnOpts = [];
  spawnArgs = [];
  child_process.spawn = function(...args) {
    const [, argms, opts] = args;
    spawnOpts.push(opts);
    spawnArgs.push(argms);
    return spawn.apply(child_process, args);
  };
});

describe('Basic', () => {
  if (process.env.TEST_TIMEOUT) this.timeout(process.env.TEST_TIMEOUT);
  afterEach(() => {
    Date.now = now;
    fs.watchFile = watchFile;
    fs.removeSync(tmpDirs.tmp1);
    fs.removeSync(tmpDirs.tmp2);
    child_process.spawn = spawn;
  });

  test('check equivalence between options and default options', () => {
    const soyCompilerB = new SoyCompiler();
    const bDefaults = soyCompilerB.getDefaultOptions();
    bDefaults.fakeKey = 0;
    expect(soyCompiler.getDefaultOptions()).toEqual(
      soyCompilerB.getDefaultOptions()
    );
    expect(soyCompilerB._options).not.toBe(soyCompilerB.getDefaultOptions());
  });

  test('make sure default options are not modified', () => {
    const compiler1 = new SoyCompiler({ allowDynamicRecompile: true });
    const compiler2 = new SoyCompiler({ allowDynamicRecompile: false });
    expect(compiler1.getDefaultOptions()).toEqual(
      compiler2.getDefaultOptions()
    );
  });

  test('test compile templates', async () => {
    await soyCompiler.compileTemplates(assetsPath);
    assertTemplatesContents();
  });

  test('test compile templates watch', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await soyCompiler.compileTemplates(assetsPath);
    expect(watchFiles.map(f => path.basename(f))).toEqual([
      'template1.soy',
      'template2.soy',
      'template3.soy',
    ]);
    expect(spawnOpts).toEqual([{ cwd: assetsPath }]);

    const [args1] = spawnArgs;
    expect(args1.slice(-3)).toEqual([
      'template1.soy',
      'template2.soy',
      'template3.soy',
    ]);

    time += 1000;
    await delay(1);
    await watchCallbacks[1]();

    expect(watchFiles.map(f => path.basename(f))).toEqual([
      'template1.soy',
      'template2.soy',
      'template3.soy',
    ]);
    expect(spawnOpts).toEqual([{ cwd: assetsPath }, { cwd: assetsPath }]);

    const args2 = spawnArgs[1];
    const secondLastArg = args2[args2.length - 2];
    expect(secondLastArg.indexOf(tmpPath)).toEqual(0);

    const lastArg = args2[args2.length - 1];
    expect(lastArg).toEqual('template2.soy');
    return null;
  });

  test('test compile templates watch del template', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await soyCompiler.compileTemplates(assetsPath);

    expect(soyCompiler.render('template3.main', {})).toEqual(
      'The default template'
    );
    expect(soyCompiler.render('template3.main', { type: 'hello' })).toEqual(
      'Hello world'
    );
    expect(soyCompiler.render('template3.main', { type: 'goodbye' })).toEqual(
      'The default template'
    );

    time += 1000;
    await delay(1);

    await watchCallbacks[1]();

    expect(soyCompiler.render('template3.main', {})).toEqual(
      'The default template'
    );
    expect(soyCompiler.render('template3.main', { type: 'hello' })).toEqual(
      'Hello world'
    );
    expect(soyCompiler.render('template3.main', { type: 'goodbye' })).toEqual(
      'The default template'
    );
  });

  test('test compile template files', async () => {
    await soyCompiler.compileTemplateFiles([
      path.join(assetsPath, 'template1.soy'),
      path.join(assetsPath, 'template2.soy'),
    ]);
    assertTemplatesContents();
  });

  test('test compile template files relative path', async () => {
    soyCompiler.setOptions({ inputDir: __dirname });
    await soyCompiler.compileTemplateFiles([
      path.join(assetsPath, 'template1.soy'),
      path.join(assetsPath, 'template2.soy'),
    ]);
    assertTemplatesContents();
  });

  test('test compile and translate templates', async () => {
    soyCompiler.setOptions({
      locales: ['pt-BR'],
      messageFilePathFormat: path.join(assetsPath, 'translations_pt-BR.xlf'),
    });

    await soyCompiler.compileTemplates(assetsPath);
    assertTemplatesContents('pt-BR');
  });

  test('test compile and translate multiple languages templates', async () => {
    soyCompiler.setOptions({
      locales: ['pt-BR', 'es'],
      messageFilePathFormat: path.join(assetsPath, 'translations_{LOCALE}.xlf'),
    });

    await soyCompiler.compileTemplates(assetsPath);
    assertTemplatesContents('pt-BR');
    assertTemplatesContents('es');
  });

  test('test default should declare top level namespaces', async () => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    await soyCompiler.compileTemplateFiles([
      path.join(assetsPath, 'template1.soy'),
    ]);

    const soyJsFilePath = path.join(
      tmpPath,
      __dirname,
      'assets/template1.soy.js'
    );

    const contents = await promisify(fs.readFile)(soyJsFilePath, 'utf8');
    expect(contents.indexOf('var template1 =')).not.toEqual(-1);
  });

  test('test false should declare top level namespaces', async () => {
    soyCompiler.setOptions({
      shouldDeclareTopLevelNamespaces: false,
      contextJsPaths: [path.join(assetsPath, 'template1_namespace.js')],
      uniqueDir: false,
    });
    await soyCompiler.compileTemplateFiles([
      path.join(assetsPath, 'template1.soy'),
    ]);

    const soyJsFilePath = path.join(
      tmpPath,
      __dirname,
      'assets/template1.soy.js'
    );
    const contents = await promisify(fs.readFile)(soyJsFilePath, 'utf8');

    expect(contents.indexOf('var template1 =')).toEqual(-1);
  });

  test('test with ij data', async () => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    await soyCompiler.compileTemplateFiles([
      path.join(assetsPath, 'template1.soy'),
      path.join(assetsPath, 'template2.soy'),
    ]);

    const soyJsFilePath = path.join(
      tmpPath,
      __dirname,
      'assets/template2.soy.js'
    );
    const contents = await promisify(fs.readFile)(soyJsFilePath, 'utf8');
    expect(contents.indexOf('template1.formletter(opt_data)')).not.toEqual(-1);
  });

  test('test precompile templates one compiler', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDirs.tmp1,
      uniqueDir: false,
      precompiledDir: tmpDirs.tmp1,
    });

    await soyCompiler.compileTemplates(assetsPath);

    expect(spawnOpts).toHaveLength(1);
    await soyCompiler.compileTemplates(assetsPath);

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents(null, soyCompiler);
  });

  test('test precompile templates two compilers', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDirs.tmp1,
      uniqueDir: false,
    });

    const soyCompilerB = new SoyCompiler({
      precompiledDir: tmpDirs.tmp1,
      outputDir: tmpDirs.tmp2,
      uniqueDir: false,
    });

    await soyCompiler.compileTemplates(assetsPath);

    expect(spawnOpts).toHaveLength(1);
    await soyCompilerB.compileTemplates(assetsPath);

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents(null, soyCompiler);
    assertTemplatesContents(null, soyCompilerB);
  });

  test('test precompile templates one compiler mult languages', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDirs.tmp1,
      uniqueDir: false,
      precompiledDir: tmpDirs.tmp1,
      locales: ['pt-BR', 'es'],
      messageFilePathFormat: path.join(assetsPath, 'translations_{LOCALE}.xlf'),
    });

    await soyCompiler.compileTemplates(assetsPath);

    expect(spawnOpts).toHaveLength(1);
    await soyCompiler.compileTemplates(assetsPath);

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents('es');
    assertTemplatesContents('pt-BR');
  });

  test('test dynamic recompile when event handler throws', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });

    await soyCompiler.compileTemplates(assetsPath);

    const [args1] = spawnArgs;
    expect(args1.pop()).toEqual('template3.soy');
    time += 1000;
    await delay(1);

    await watchCallbacks[1]();

    const [args2] = spawnArgs;
    expect(args2.pop()).toEqual('template2.soy');
    time += 1000;
    await delay(1);

    await watchCallbacks[0]();

    const [args3] = spawnArgs;
    expect(args3.pop()).toEqual('template1.soy');
  });
});
