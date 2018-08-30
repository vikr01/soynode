import child_process from 'child_process';
import fs, { watchFile } from 'fs-extra';
import path from 'path';
import delay from 'delay';
import { promisify } from 'util';
import { SoyCompiler } from '../src/soynode';

const { now } = Date;
const { spawn } = child_process;

let watchFiles;
let watchCallbacks;
let spawnOpts;
let spawnArgs;
let time;
let soyCompiler;
const tmpDir1 = path.join(__dirname, 'tmp1');
const tmpDir2 = path.join(__dirname, 'tmp2');

function assertTemplatesContents(locale, opt_soyCompiler) {
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
}

beforeEach(done => {
  soyCompiler = new SoyCompiler();

  time = 1;
  Date.now = function() {
    return time;
  };

  watchFiles = [];
  watchCallbacks = [];
  fs.watchFile = function(f, opts, callback) {
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

  done();
});

describe('Basic', () => {
  if (process.env.TEST_TIMEOUT) this.timeout(process.env.TEST_TIMEOUT);
  afterEach(() => {
    Date.now = now;
    fs.watchFile = watchFile;
    fs.removeSync(tmpDir1);
    fs.removeSync(tmpDir2);
    child_process.spawn = spawn;
  });

  test('test compile templates', done => {
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      expect(err).toBeFalsy();
      expect(assertTemplatesContents).not.toThrow();
      done();
    });
  });

  test('test compile templates watch', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );
    expect(watchFiles.map(f => path.basename(f))).toEqual([
      'template1.soy',
      'template2.soy',
      'template3.soy',
    ]);
    expect(spawnOpts).toEqual([{ cwd: `${__dirname}/assets` }]);

    const args1 = spawnArgs[0];
    expect(args1.slice(args1.length - 3, args1.length)).toEqual([
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
    expect(spawnOpts).toEqual([
      { cwd: `${__dirname}/assets` },
      { cwd: `${__dirname}/assets` },
    ]);

    const args2 = spawnArgs[1];
    const secondLastArg = args2[args2.length - 2];
    expect(secondLastArg.indexOf('/tmp/soynode')).toEqual(0);

    const lastArg = args2[args2.length - 1];
    expect(lastArg).toEqual('template2.soy');
    return null;
  });

  test('test compile templates watch del template', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );

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

  test('test compile template files', done => {
    soyCompiler.compileTemplateFiles(
      [
        `${__dirname}/assets/template1.soy`,
        `${__dirname}/assets/template2.soy`,
      ],
      err => {
        expect(err).toBeFalsy();
        expect(assertTemplatesContents.bind(null)).not.toThrow();
        done();
      }
    );
  });

  test('test compile template files relative path', done => {
    soyCompiler.setOptions({ inputDir: __dirname });
    soyCompiler.compileTemplateFiles(
      ['./assets/template1.soy', './assets/template2.soy'],
      err => {
        expect(err).toBeFalsy();
        expect(assertTemplatesContents.bind(null)).not.toThrow();
        done();
      }
    );
  });

  test('test compile and translate templates', done => {
    soyCompiler.setOptions({
      locales: ['pt-BR'],
      messageFilePathFormat: `${__dirname}/assets/translations_pt-BR.xlf`,
    });
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      expect(err).toBeFalsy();
      expect(assertTemplatesContents.bind(null, 'pt-BR')).not.toThrow();
      done();
    });
  });

  test('test compile and translate multiple languages templates', done => {
    soyCompiler.setOptions({
      locales: ['pt-BR', 'es'],
      messageFilePathFormat: `${__dirname}/assets/translations_{LOCALE}.xlf`,
    });
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      expect(err).toBeFalsy();
      expect(assertTemplatesContents.bind(null, 'pt-BR')).not.toThrow();
      expect(assertTemplatesContents.bind(null, 'es')).not.toThrow();
      done();
    });
  });

  test('test default should declare top level namespaces', done => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [`${__dirname}/assets/template1.soy`],
      err => {
        expect(err).toBeFalsy();

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template1.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        expect(contents.indexOf('var template1 =')).not.toEqual(-1);

        done();
      }
    );
  });

  test('test false should declare top level namespaces', done => {
    soyCompiler.setOptions({
      shouldDeclareTopLevelNamespaces: false,
      contextJsPaths: [path.join(__dirname, '/assets/template1_namespace.js')],
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [`${__dirname}/assets/template1.soy`],
      err => {
        expect(err).toBeFalsy();

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template1.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        expect(contents.indexOf('var template1 =')).toEqual(-1);
        done();
      }
    );
  });

  test('test with ij data', done => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [
        `${__dirname}/assets/template1.soy`,
        `${__dirname}/assets/template2.soy`,
      ],
      err => {
        expect(err).toBeFalsy();

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template2.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        expect(
          contents.indexOf('template1.formletter(opt_data, null, opt_ijData)')
        ).not.toEqual(-1);
        done();
      }
    );
  });

  test('test precompile templates one compiler', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDir1,
      uniqueDir: false,
      precompiledDir: tmpDir1,
    });

    await promisify(soyCompiler.compileTemplates).bind(
      soyCompiler,
      `${__dirname}/assets`
    )();

    expect(spawnOpts).toHaveLength(1);
    await promisify(soyCompiler.compileTemplates).bind(
      soyCompiler,
      `${__dirname}/assets`
    )();

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents(null, soyCompiler);
  });

  test('test precompile templates two compilers', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDir1,
      uniqueDir: false,
    });

    const soyCompilerB = new SoyCompiler();
    soyCompilerB.setOptions({
      precompiledDir: tmpDir1,
      outputDir: tmpDir2,
      uniqueDir: false,
    });

    await promisify(soyCompiler.compileTemplates).bind(
      soyCompiler,
      `${__dirname}/assets`
    )();

    expect(spawnOpts).toHaveLength(1);
    await promisify(soyCompilerB.compileTemplates).bind(soyCompilerB)(
      `${__dirname}/assets`
    );

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents(null, soyCompiler);
    assertTemplatesContents(null, soyCompilerB);
  });

  test('test precompile templates one compiler mult languages', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDir1,
      uniqueDir: false,
      precompiledDir: tmpDir1,
      locales: ['pt-BR', 'es'],
      messageFilePathFormat: `${__dirname}/assets/translations_{LOCALE}.xlf`,
    });

    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );

    expect(spawnOpts).toHaveLength(1);
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    expect(spawnOpts).toHaveLength(1);
    assertTemplatesContents('es');
    assertTemplatesContents('pt-BR');
  });

  test('test dynamic recompile when event handler throws', async () => {
    // this.timeout(4000);
    soyCompiler.setOptions({ allowDynamicRecompile: true });

    const errToThrow = 'Deliberately thrown error';
    let errorWasThrown = false;
    try {
      await new Promise((resolve, reject) => {
        const callback = function(err) {
          return err ? reject(err) : resolve(null);
        };
        const emitter = soyCompiler.compileTemplates(
          `${__dirname}/assets`,
          callback
        );
        emitter.on('compile', () => {
          errorWasThrown = true;
          throw errToThrow;
        });
      });
    } catch (err) {
      expect(err.message).toEqual(errToThrow.message);
    }

    expect(errorWasThrown).toEqual(true);

    const args1 = spawnArgs.slice(0)[0];
    expect(args1.pop()).toEqual('template3.soy');
    time += 1000;
    await delay(1);

    await watchCallbacks[1]();

    const args2 = spawnArgs.slice(0)[0];
    expect(args2.pop()).toEqual('template2.soy');
    time += 1000;
    await delay(1);

    await watchCallbacks[0]();

    const args3 = spawnArgs.slice(0)[0];
    expect(args3.pop()).toEqual('template1.soy');
  });
});
