

const child_process = require('child_process')
const fs = require('fs-extra');
const path = require('path');
const nodeunitq = require('nodeunitq')

const builder = new nodeunitq.Builder(exports)
const Q = require('q')
const soynode = require('../lib/soynode.js');

const watchFile = fs.watchFile
const now = Date.now
const spawn = child_process.spawn

let watchFiles
let watchCallbacks
let spawnOpts
let spawnArgs
let time
let soyCompiler
const tmpDir1 = path.join(__dirname, 'tmp1')
const tmpDir2 = path.join(__dirname, 'tmp2')

exports.setUp = function (done) {
  soyCompiler = new soynode.SoyCompiler()

  time = 1
  Date.now = function () { return time; }

  watchFiles = [];
  watchCallbacks = [];
  fs.watchFile = function (f, opts, callback) {
    watchFiles.push(f);
    watchCallbacks.push(callback);
  };

  spawnOpts = []
  spawnArgs = []
  child_process.spawn = function (prog, args, opts) {
    spawnOpts.push(opts)
    spawnArgs.push(args)
    return spawn.apply(child_process, arguments)
  }
  done()
}

exports.tearDown = function (done) {
  Date.now = now;
  fs.watchFile = watchFile;
  fs.removeSync(tmpDir1)
  fs.removeSync(tmpDir2)
  child_process.spawn = spawn;
  done();
}

builder.add((test) => {
  soyCompiler.compileTemplates(`${__dirname  }/assets`, (err) => {
    test.ifError(err);
    test.doesNotThrow(assertTemplatesContents.bind(null, test));
    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({allowDynamicRecompile: true})
  return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler), `${__dirname  }/assets`).then(() => {
    test.deepEqual(['template1.soy', 'template2.soy', 'template3.soy'], watchFiles.map((f) => path.basename(f)))
    test.deepEqual([{cwd: `${__dirname  }/assets`}], spawnOpts)

    const args = spawnArgs[0]
    test.deepEqual(['template1.soy', 'template2.soy', 'template3.soy'],
                   args.slice(args.length - 3, args.length))

    time += 1000
    return Q.delay(1)
  }).then(() => watchCallbacks[1]()).then(() => {
    test.deepEqual(['template1.soy', 'template2.soy', 'template3.soy'], watchFiles.map((f) => path.basename(f)))
    test.deepEqual([{cwd: `${__dirname  }/assets`}, {cwd: `${__dirname  }/assets`}], spawnOpts)

    const args = spawnArgs[1]
    const secondLastArg = args[args.length - 2]
    test.ok(secondLastArg.indexOf('/tmp/soynode') == 0)

    const lastArg = args[args.length - 1]
    test.equal('template2.soy', lastArg)
  })
})

builder.add((test) => {
  soyCompiler.setOptions({allowDynamicRecompile: true})
  return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler), `${__dirname  }/assets`).then(() => {
    test.equal('The default template', soyCompiler.render('template3.main', {}))
    test.equal('Hello world', soyCompiler.render('template3.main', {type: 'hello'}))
    test.equal('The default template', soyCompiler.render('template3.main', {type: 'goodbye'}))

    time += 1000
    return Q.delay(1)
  }).then(() => watchCallbacks[1]()).then(() => {
    test.equal('The default template', soyCompiler.render('template3.main', {}))
    test.equal('Hello world', soyCompiler.render('template3.main', {type: 'hello'}))
    test.equal('The default template', soyCompiler.render('template3.main', {type: 'goodbye'}))
  });
})

builder.add((test) => {
  soyCompiler.compileTemplateFiles([`${__dirname  }/assets/template1.soy`, `${__dirname  }/assets/template2.soy`], (err) => {
    test.ifError(err);
    test.doesNotThrow(assertTemplatesContents.bind(null, test));
    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({ inputDir: __dirname });
  soyCompiler.compileTemplateFiles(['./assets/template1.soy', './assets/template2.soy'], (err) => {
    test.ifError(err);
    test.doesNotThrow(assertTemplatesContents.bind(null, test));
    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    locales: ['pt-BR'],
    messageFilePathFormat: `${__dirname  }/assets/translations_pt-BR.xlf`,
  });
  soyCompiler.compileTemplates(`${__dirname  }/assets`, (err) => {
    test.ifError(err);
    test.doesNotThrow(assertTemplatesContents.bind(null, test, 'pt-BR'));
    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    locales: ['pt-BR', 'es'],
    messageFilePathFormat: `${__dirname  }/assets/translations_{LOCALE}.xlf`,
  });
  soyCompiler.compileTemplates(`${__dirname  }/assets`, (err) => {
    test.ifError(err);
    test.doesNotThrow(assertTemplatesContents.bind(null, test, 'pt-BR'));
    test.doesNotThrow(assertTemplatesContents.bind(null, test, 'es'));
    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    uniqueDir: false,
  });
  soyCompiler.compileTemplateFiles([`${__dirname  }/assets/template1.soy`], (err) => {
    test.ifError(err);

    const soyJsFilePath = path.join('/tmp/soynode', __dirname, 'assets/template1.soy.js');
    const contents = fs.readFileSync(soyJsFilePath, 'utf8');
    test.notEqual(-1, contents.indexOf('var template1 ='));

    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    shouldDeclareTopLevelNamespaces: false,
    contextJsPaths: [path.join(__dirname, '/assets/template1_namespace.js')],
    uniqueDir: false,
  });
  soyCompiler.compileTemplateFiles([`${__dirname  }/assets/template1.soy`], (err) => {
    test.ifError(err);

    const soyJsFilePath = path.join('/tmp/soynode', __dirname, 'assets/template1.soy.js');
    const contents = fs.readFileSync(soyJsFilePath, 'utf8');
    test.equal(-1, contents.indexOf('var template1 ='));

    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    uniqueDir: false,
  });
  soyCompiler.compileTemplateFiles([`${__dirname  }/assets/template1.soy`, `${__dirname  }/assets/template2.soy`], (err) => {
    test.ifError(err);

    const soyJsFilePath = path.join('/tmp/soynode', __dirname, 'assets/template2.soy.js');
    const contents = fs.readFileSync(soyJsFilePath, 'utf8');
    test.notEqual(-1, contents.indexOf('template1.formletter(opt_data, null, opt_ijData)'));

    test.done();
  });
})

builder.add((test) => {
  soyCompiler.setOptions({
    outputDir: tmpDir1,
    uniqueDir: false,
    precompiledDir: tmpDir1,
  })

  return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler, `${__dirname  }/assets`))
    .then(() => {
      test.equal(1, spawnOpts.length)
      return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler, `${__dirname  }/assets`))
    })
    .then(() => {
      // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
      test.equal(1, spawnOpts.length)
      assertTemplatesContents(test, null, soyCompiler)
    })
})

builder.add((test) => {
  soyCompiler.setOptions({
    outputDir: tmpDir1,
    uniqueDir: false,
  })

  const soyCompilerB = new soynode.SoyCompiler()
  soyCompilerB.setOptions({
    precompiledDir: tmpDir1,
    outputDir: tmpDir2,
    uniqueDir: false,
  })

  return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler, `${__dirname  }/assets`))
    .then(() => {
      test.equal(1, spawnOpts.length)
      return Q.nfcall(soyCompilerB.compileTemplates.bind(soyCompilerB, `${__dirname  }/assets`))
    })
    .then(() => {
      // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
      test.equal(1, spawnOpts.length)
      assertTemplatesContents(test, null, soyCompiler)
      assertTemplatesContents(test, null, soyCompilerB)
    })
})

builder.add((test) => {
  soyCompiler.setOptions({
    outputDir: tmpDir1,
    uniqueDir: false,
    precompiledDir: tmpDir1,
    locales: ['pt-BR', 'es'],
    messageFilePathFormat: `${__dirname  }/assets/translations_{LOCALE}.xlf`,
  })

  return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler, `${__dirname  }/assets`))
    .then(() => {
      test.equal(1, spawnOpts.length)
      return Q.nfcall(soyCompiler.compileTemplates.bind(soyCompiler, `${__dirname  }/assets`))
    })
    .then(() => {
      // Confirm that we re-used the precompiled templates and didn't start a new soy binary.
      test.equal(1, spawnOpts.length)
      assertTemplatesContents(test, 'es')
      assertTemplatesContents(test, 'pt-BR')
    })
})

builder.add((test) => {
  soyCompiler.setOptions({allowDynamicRecompile: true})

  const defer = Q.defer()
  const callback = function (err) {
    if (err) {
      defer.reject(err)
    } else {
      defer.resolve(null)
    }
  }
  const emitter = soyCompiler.compileTemplates(`${__dirname  }/assets`, callback)
  emitter.on('compile', () => {
    throw new Error('Deliberately thrown error')
  })

  return defer.promise.then(() => {
    const args = spawnArgs.slice(0)[0]
    test.equal('template3.soy', args.pop())

    time += 1000
    return Q.delay(1)
  }).then(() => watchCallbacks[1]()).then(() => {
    const args = spawnArgs.slice(0)[0]
    test.equal('template2.soy', args.pop())
    time += 1000
    return Q.delay(1)
  }).then(() => watchCallbacks[0]()).then(() => {
    const args = spawnArgs.slice(0)[0]
    test.equal('template1.soy', args.pop())
  })
})

function assertTemplatesContents(test, locale, opt_soyCompiler) {
  const underTest = opt_soyCompiler || soyCompiler
  const template1 = underTest.render('template1.formletter', { title: 'Mr.', surname: 'Pupius' }, null, locale);
  const template2 = underTest.render('template2.formletter', { title: 'Mr.', surname: 'Santos' }, null, locale);

  test.equal('string', typeof template1)
  test.equal('string', typeof template2)

  switch (locale) {
    case 'pt-BR':
      test.equal(template1, 'Querido Mr. Pupius: Com um nome como Mr. Pupius, você não deveria ter o seu própro tema musical? Nós podemos ajudar!');
      test.equal(template2, 'Querido Mr. Santos: Com um nome como Mr. Santos, você não deveria ter o seu própro tema musical? Nós podemos ajudar!');
      break;
    case 'es':
      test.equal(template1, 'Estimado Mr. Pupius: Con un nombre como Mr. Pupius, ¿no debería tener su propia canción? Nosotros podemos ayudarle!');
      test.equal(template2, 'Estimado Mr. Santos: Con un nombre como Mr. Santos, ¿no debería tener su propia canción? Nosotros podemos ayudarle!');
      break;
    default:
      test.equal(template1, 'Dear Mr. Pupius: With a name like Mr. Pupius, shouldn\'t you have your own theme song? We can help!');
      test.equal(template2, 'Dear Mr. Santos: With a name like Mr. Santos, shouldn\'t you have your own theme song? We can help!');
      break;
  }
}
