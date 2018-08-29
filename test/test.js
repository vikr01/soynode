import child_process from 'child_process';
import fs, { watchFile } from 'fs-extra';
import path from 'path';
import delay from 'delay';
import assert from 'assert';
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

  assert.equal('string', typeof template1);
  assert.equal('string', typeof template2);

  switch (locale) {
    case 'pt-BR':
      assert.equal(
        template1,
        'Querido Mr. Pupius: Com um nome como Mr. Pupius, você não deveria ter o seu própro tema musical? Nós podemos ajudar!'
      );
      assert.equal(
        template2,
        'Querido Mr. Santos: Com um nome como Mr. Santos, você não deveria ter o seu própro tema musical? Nós podemos ajudar!'
      );
      break;
    case 'es':
      assert.equal(
        template1,
        'Estimado Mr. Pupius: Con un nombre como Mr. Pupius, ¿no debería tener su propia canción? Nosotros podemos ayudarle!'
      );
      assert.equal(
        template2,
        'Estimado Mr. Santos: Con un nombre como Mr. Santos, ¿no debería tener su propia canción? Nosotros podemos ayudarle!'
      );
      break;
    default:
      assert.equal(
        template1,
        "Dear Mr. Pupius: With a name like Mr. Pupius, shouldn't you have your own theme song? We can help!"
      );
      assert.equal(
        template2,
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
  afterEach(() => {
    Date.now = now;
    fs.watchFile = watchFile;
    fs.removeSync(tmpDir1);
    fs.removeSync(tmpDir2);
    child_process.spawn = spawn;
  });

  it('test compile templates', done => {
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      assert.ifError(err);
      assert.doesNotThrow(assertTemplatesContents);
      done();
    });
  });

  it('test compile templates watch', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );
    assert.deepEqual(
      ['template1.soy', 'template2.soy', 'template3.soy'],
      watchFiles.map(f => path.basename(f))
    );
    assert.deepEqual([{ cwd: `${__dirname}/assets` }], spawnOpts);

    const args1 = spawnArgs[0];
    assert.deepEqual(
      ['template1.soy', 'template2.soy', 'template3.soy'],
      args1.slice(args1.length - 3, args1.length)
    );

    time += 1000;
    await delay(1);
    await watchCallbacks[1]();

    assert.deepEqual(
      ['template1.soy', 'template2.soy', 'template3.soy'],
      watchFiles.map(f => path.basename(f))
    );
    assert.deepEqual(
      [{ cwd: `${__dirname}/assets` }, { cwd: `${__dirname}/assets` }],
      spawnOpts
    );

    const args2 = spawnArgs[1];
    const secondLastArg = args2[args2.length - 2];
    assert.ok(secondLastArg.indexOf('/tmp/soynode') === 0);

    const lastArg = args2[args2.length - 1];
    assert.equal('template2.soy', lastArg);
    return null;
  });

  it('test compile templates watch del template', async () => {
    soyCompiler.setOptions({ allowDynamicRecompile: true });
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );

    assert.equal(
      'The default template',
      soyCompiler.render('template3.main', {})
    );
    assert.equal(
      'Hello world',
      soyCompiler.render('template3.main', { type: 'hello' })
    );
    assert.equal(
      'The default template',
      soyCompiler.render('template3.main', { type: 'goodbye' })
    );

    time += 1000;
    await delay(1);

    await watchCallbacks[1]();

    assert.equal(
      'The default template',
      soyCompiler.render('template3.main', {})
    );
    assert.equal(
      'Hello world',
      soyCompiler.render('template3.main', { type: 'hello' })
    );
    assert.equal(
      'The default template',
      soyCompiler.render('template3.main', { type: 'goodbye' })
    );
  });

  it('test compile template files', done => {
    soyCompiler.compileTemplateFiles(
      [
        `${__dirname}/assets/template1.soy`,
        `${__dirname}/assets/template2.soy`,
      ],
      err => {
        assert.ifError(err);
        assert.doesNotThrow(assertTemplatesContents.bind(null));
        done();
      }
    );
  });

  it('test compile template files relative path', done => {
    soyCompiler.setOptions({ inputDir: __dirname });
    soyCompiler.compileTemplateFiles(
      ['./assets/template1.soy', './assets/template2.soy'],
      err => {
        assert.ifError(err);
        assert.doesNotThrow(assertTemplatesContents.bind(null));
        done();
      }
    );
  });

  it('test compile and translate templates', done => {
    soyCompiler.setOptions({
      locales: ['pt-BR'],
      messageFilePathFormat: `${__dirname}/assets/translations_pt-BR.xlf`,
    });
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      assert.ifError(err);
      assert.doesNotThrow(assertTemplatesContents.bind(null, 'pt-BR'));
      done();
    });
  });

  it('test compile and translate multiple languages templates', done => {
    soyCompiler.setOptions({
      locales: ['pt-BR', 'es'],
      messageFilePathFormat: `${__dirname}/assets/translations_{LOCALE}.xlf`,
    });
    soyCompiler.compileTemplates(`${__dirname}/assets`, err => {
      assert.ifError(err);
      assert.doesNotThrow(assertTemplatesContents.bind(null, 'pt-BR'));
      assert.doesNotThrow(assertTemplatesContents.bind(null, 'es'));
      done();
    });
  });

  it('test default should declare top level namespaces', done => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [`${__dirname}/assets/template1.soy`],
      err => {
        assert.ifError(err);

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template1.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        assert.notEqual(-1, contents.indexOf('var template1 ='));

        done();
      }
    );
  });

  it('test false should declare top level namespaces', done => {
    soyCompiler.setOptions({
      shouldDeclareTopLevelNamespaces: false,
      contextJsPaths: [path.join(__dirname, '/assets/template1_namespace.js')],
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [`${__dirname}/assets/template1.soy`],
      err => {
        assert.ifError(err);

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template1.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        assert.equal(-1, contents.indexOf('var template1 ='));

        done();
      }
    );
  });

  it('test with ij data', done => {
    soyCompiler.setOptions({
      uniqueDir: false,
    });
    soyCompiler.compileTemplateFiles(
      [
        `${__dirname}/assets/template1.soy`,
        `${__dirname}/assets/template2.soy`,
      ],
      err => {
        assert.ifError(err);

        const soyJsFilePath = path.join(
          '/tmp/soynode',
          __dirname,
          'assets/template2.soy.js'
        );
        const contents = fs.readFileSync(soyJsFilePath, 'utf8');
        assert.notEqual(
          -1,
          contents.indexOf('template1.formletter(opt_data, null, opt_ijData)')
        );

        done();
      }
    );
  });

  it('test precompile templates one compiler', async () => {
    soyCompiler.setOptions({
      outputDir: tmpDir1,
      uniqueDir: false,
      precompiledDir: tmpDir1,
    });

    await promisify(soyCompiler.compileTemplates).bind(
      soyCompiler,
      `${__dirname}/assets`
    )();

    assert.equal(1, spawnOpts.length);
    await promisify(soyCompiler.compileTemplates).bind(
      soyCompiler,
      `${__dirname}/assets`
    )();

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    assert.equal(1, spawnOpts.length);
    assertTemplatesContents(null, soyCompiler);
  });

  it('test precompile templates two compilers', async () => {
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

    assert.equal(1, spawnOpts.length);
    await promisify(soyCompilerB.compileTemplates).bind(soyCompilerB)(
      `${__dirname}/assets`
    );

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    assert.equal(1, spawnOpts.length);
    assertTemplatesContents(null, soyCompiler);
    assertTemplatesContents(null, soyCompilerB);
  });

  it('test precompile templates one compiler mult languages', async () => {
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

    assert.equal(1, spawnOpts.length);
    await promisify(soyCompiler.compileTemplates).bind(soyCompiler)(
      `${__dirname}/assets`
    );

    // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
    assert.equal(1, spawnOpts.length);
    assertTemplatesContents('es');
    assertTemplatesContents('pt-BR');
  });

  it('test dynamic recompile when event handler throws', async function() {
    this.timeout(4000);
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
      assert.equal(err.message, errToThrow.message);
    }

    assert.equal(errorWasThrown, true);

    const args1 = spawnArgs.slice(0)[0];
    assert.equal('template3.soy', args1.pop());
    time += 1000;
    await delay(1);

    await watchCallbacks[1]();

    const args2 = spawnArgs.slice(0)[0];
    assert.equal('template2.soy', args2.pop());
    time += 1000;
    await delay(1);

    await watchCallbacks[0]();

    const args3 = spawnArgs.slice(0)[0];
    assert.equal('template1.soy', args3.pop());
  });
});
