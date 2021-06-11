'use strict';

const fs = require('fs');
const vm = require('vm');
const v8 = require('v8');
const path = require('path');
const { fork } = require('child_process');
const Module = require('module');
const sourceMap = require('source-map');

v8.setFlagsFromString('--no-lazy');

if (Number.parseInt(process.versions.node.split('.')[0], 10) >= 12) {
  v8.setFlagsFromString('--no-flush-bytecode'); // Thanks to A-Parser (@a-parser)
}

const COMPILED_EXTNAME = '.jsc';
const DUMMYCODE_LENGTH = 4;

/**
 * Generates v8 bytecode buffer.
 * @param   {string} javascriptCode JavaScript source that will be compiled to bytecode.
 * @returns {Buffer} The generated bytecode.
 */
const compileCode = function (javascriptCode) {

  if (typeof javascriptCode !== 'string') {
    throw new Error(`javascriptCode must be string. ${typeof javascriptCode} was given.`);
  }

  let script = new vm.Script(javascriptCode, {
    produceCachedData: true
  });

  let bytecodeBuffer = (script.createCachedData && script.createCachedData.call) ?
    script.createCachedData()
    :
    script.cachedData;

  return bytecodeBuffer;
};

/**
 * This function runs the compileCode() function (above)
 * via a child process usine Electron as Node
 * @param {string} javascriptCode 
 * @returns {Promise<Buffer>} - returns a Promise which resolves in the generated bytecode.
 */
const compileElectronCode = function (javascriptCode) {
  // console.log('\nCompiling with Electron\n')
  return new Promise((resolve, reject) => {
    let data = Buffer.from([]);

    const electronPath = path.join('node_modules', 'electron', 'cli.js');
    if (!fs.existsSync(electronPath)) {
      throw new Error('Electron not installed');
    }
    const bytenodePath = path.join(__dirname, 'cli.js');

    // create a subprocess in which we run Electron as our Node and V8 engine
    // running Bytenode to compile our code through stdin/stdout
    const proc = fork(electronPath, [bytenodePath, '--compile', '--no-module', '-'], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    proc.stdin.write(javascriptCode);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
    })

    proc.stdout.on('error', (err) => {
      console.error(err);
    })
    proc.stdout.on('end', () => {
      resolve(data);
    })

    proc.stderr.on('data', (chunk) => {
      console.error('Error: ', chunk);
    })
    proc.stderr.on('error', (err) => {
      console.error('Error: ', err);
    })

    proc.addListener('message', (message) => console.log(message));
    proc.addListener('error', err => console.error(err));

    proc.on('error', (err) => reject(err));
    proc.on('exit', () => { resolve(data) });
  });
};

// TODO: rewrite this function
const fixBytecode = function (bytecodeBuffer) {

  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error(`bytecodeBuffer must be a buffer object.`);
  }

  let dummyBytecode = compileCode('"ಠ_ಠ"');

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    dummyBytecode.slice(16, 20).copy(bytecodeBuffer, 16);
    dummyBytecode.slice(20, 24).copy(bytecodeBuffer, 20);
  } else if (process.version.startsWith('v12')
    || process.version.startsWith('v13')
    || process.version.startsWith('v14')
    || process.version.startsWith('v15')) {
    dummyBytecode.slice(12, 16).copy(bytecodeBuffer, 12);
  } else {
    dummyBytecode.slice(12, 16).copy(bytecodeBuffer, 12);
    dummyBytecode.slice(16, 20).copy(bytecodeBuffer, 16);
  }
};

// TODO: rewrite this function
const readSourceHash = function (bytecodeBuffer) {

  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error(`bytecodeBuffer must be a buffer object.`);
  }

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    return bytecodeBuffer.slice(12, 16).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0);
  } else {
    return bytecodeBuffer.slice(8, 12).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0);
  }
};

/**
 * Runs v8 bytecode buffer and returns the result.
 * @param   {Buffer} bytecodeBuffer The buffer object that was created using compileCode function.
 * @returns {any}    The result of the very last statement executed in the script.
 */
const runBytecode = function (bytecodeBuffer) {

  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error(`bytecodeBuffer must be a buffer object.`);
  }

  let dummyCode = '"';

  let dummyCodelength = bytecodeBuffer.slice(0, DUMMYCODE_LENGTH).reduce((sum, number, power) => sum += number * Math.pow(255, power), 0);
  let dummyStr = bytecodeBuffer.slice(DUMMYCODE_LENGTH, DUMMYCODE_LENGTH + dummyCodelength);
  let totalLength = 0;
  for (let i = 0; i < dummyStr.length; i++) {
    let length = dummyStr.readUInt8(i);
    totalLength += length;
    if (i == dummyStr.length - 1) {
      dummyCode += "\u200b".repeat(totalLength - 2) + '"';
      break;
    }
    if(length != 255) {
      dummyCode += "\u200b".repeat(totalLength) + "\u000a";
      totalLength = 0;
    } 
  }
  bytecodeBuffer = bytecodeBuffer.slice(DUMMYCODE_LENGTH + dummyCodelength);

  fixBytecode(bytecodeBuffer);

  let script = new vm.Script(dummyCode, {
    cachedData: bytecodeBuffer
  });

  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)');
  }

  return script.runInThisContext();
};

/**
 * Compiles JavaScript file to .jsc file.
 * @param   {object|string} args
 * @param   {string}          args.filename The JavaScript source file that will be compiled
 * @param   {boolean}         [args.compileAsModule=true] If true, the output will be a commonjs module
 * @param   {string}          [args.output=filename.jsc] The output filename. Defaults to the same path and name of the original file, but with `.jsc` extension.
 * @param   {boolean}         [args.electron=false] If true, compile code for Electron (which needs to be installed)
 * @param   {boolean}         [args.createLoader=false] If true, create a loader file.
 * @param   {boolean}         [args.loaderFilename='%.loader.js'] Filename or pattern for generated loader files. Defaults to originalFilename.loader.js. Use % as a substitute for originalFilename. 
 * @param   {string}        [output] The output filename. (Deprecated: use args.output instead)
 * @returns {Promise<string>}        A Promise which returns the compiled filename
 */
const compileFile = async function (args, output) {

  let filename, compileAsModule, electron, createLoader, loaderFilename;

  if (typeof args === 'string') {
    filename = args;
    compileAsModule = true;
    electron = false;
    createLoader = false;
  } else if (typeof args === 'object') {
    filename = args.filename;
    compileAsModule = args.compileAsModule !== false;
    electron = args.electron;
    createLoader = true;
    loaderFilename = args.loaderFilename;
    if (loaderFilename) createLoader = true;
  }

  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`);
  }

  let compiledFilename = args.output || output || filename.slice(0, -3) + COMPILED_EXTNAME;

  if (typeof compiledFilename !== 'string') {
    throw new Error(`output must be a string. ${typeof compiledFilename} was given.`);
  }

  let javascriptCode = fs.readFileSync(filename, 'utf-8');
  let code;

  if (compileAsModule) {
    code = Module.wrap(javascriptCode.replace(/^#!.*/, ''));

    // Rebuild sourcemap to locate error correctly
    let mapFilename = filename + '.map';
    if (compileAsModule && fs.existsSync(mapFilename)) {
      const offset = '(function (exports, require, module, __filename, __dirname) { ';
      await rebuildSourmap(mapFilename, offset.length);
      console.log("Rebuild sourcemap!")
    }
  } else {
    code = javascriptCode.replace(/^#!.*/, '');
  }

  let bytecodeBuffer;

  if (electron) {
    bytecodeBuffer = await compileElectronCode(code);
  } else {
    bytecodeBuffer = compileCode(code);
  }

  // generate dummyCode contained line break
  let dummyCode = await generateDummyCode(code);
  let length = dummyCode.length;
  let lengthArr = new Array(DUMMYCODE_LENGTH);
  for (let i = lengthArr.length - 1; i > 0; i--) {
    lengthArr[i] = Math.floor(length / Math.pow(255, i));
    length -= lengthArr[i] * Math.pow(255, i);
  }
  lengthArr[0] = length;
  fs.writeFileSync(compiledFilename, Buffer.from(lengthArr));
  fs.appendFileSync(compiledFilename, Buffer.from(dummyCode));
  fs.appendFileSync(compiledFilename, bytecodeBuffer);

  if (createLoader) {
    addLoaderFile(compiledFilename, loaderFilename)
  }

  return compiledFilename;
};


const generateDummyCode = async function (code) {
  const arr = code.split('\n');
  const lengthArr = [];
  for (let i = 0; i < arr.length; i++) {
    let length = arr[i].length;
    while(length >= 255) {
      lengthArr.push(255);
      length -= 255;
    }
    lengthArr.push(length);
  }
  return Buffer.from(lengthArr);
}


/**
 * Runs .jsc file and returns the result.
 * @param   {string} filename
 * @returns {any}    The result of the very last statement executed in the script.
 */
const runBytecodeFile = function (filename) {

  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`);
  }

  let bytecodeBuffer = fs.readFileSync(filename);

  return runBytecode(bytecodeBuffer);
};

Module._extensions[COMPILED_EXTNAME] = function (fileModule, filename) {

  let bytecodeBuffer = fs.readFileSync(filename);
  let dummyCode = '"';

  let dummyCodelength = bytecodeBuffer.slice(0, DUMMYCODE_LENGTH).reduce((sum, number, power) => sum += number * Math.pow(255, power), 0);
  let dummyStr = bytecodeBuffer.slice(DUMMYCODE_LENGTH, DUMMYCODE_LENGTH + dummyCodelength);
  let totalLength = 0;
  for (let i = 0; i < dummyStr.length; i++) {
    let length = dummyStr.readUInt8(i);
    totalLength += length;
    if (i == dummyStr.length - 1) {
      dummyCode += "\u200b".repeat(totalLength - 2) + '"';
      break;
    }
    if(length != 255) {
      dummyCode += "\u200b".repeat(totalLength) + "\u000a";
      totalLength = 0;
    } 
  }
  bytecodeBuffer = bytecodeBuffer.slice(DUMMYCODE_LENGTH + dummyCodelength);

  fixBytecode(bytecodeBuffer);

  let script = new vm.Script(dummyCode, {
    filename: filename,
    lineOffset: 0,
    displayErrors: true,
    cachedData: bytecodeBuffer
  });

  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)');
  }

  /*
  This part is based on:
  https://github.com/zertosh/v8-compile-cache/blob/7182bd0e30ab6f6421365cee0a0c4a8679e9eb7c/v8-compile-cache.js#L158-L178
  */

  function require(id) {
    return fileModule.require(id);
  }
  require.resolve = function (request, options) {
    return Module._resolveFilename(request, fileModule, false, options);
  };
  require.main = process.mainModule;

  require.extensions = Module._extensions;
  require.cache = Module._cache;

  let compiledWrapper = script.runInThisContext({
    filename: filename,
    lineOffset: 0,
    columnOffset: 0,
    displayErrors: true,
  });

  let dirname = path.dirname(filename);

  let args = [fileModule.exports, require, fileModule, filename, dirname, process, global];

  return compiledWrapper.apply(fileModule.exports, args);
};

/**
 * Add a loader file for a given .jsc file
 * @param {String} fileToLoad path of the .jsc file we're loading
 * @param {String} loaderFilename - optional pattern or name of the file to write - defaults to filename.loader.js. Patterns: "%" represents the root name of .jsc file.
 */
function addLoaderFile(fileToLoad, loaderFilename) {
  let loaderFilePath;
  if (typeof loaderFilename === 'boolean' || loaderFilename === undefined || loaderFilename === '') {
    loaderFilePath = fileToLoad.replace('.jsc', '.loader.js');
  } else {
    loaderFilename = loaderFilename.replace('%', path.parse(fileToLoad).name);
    loaderFilePath = path.join(path.dirname(fileToLoad), loaderFilename);
  }
  const relativePath = path.relative(path.dirname(loaderFilePath), fileToLoad);
  const code = loaderCode('./' + relativePath);
  fs.writeFileSync(loaderFilePath, code);
}

function loaderCode(targetPath) {
  return `
    require('bytenode');
    require('${targetPath}');
  `;
}

async function rebuildSourmap (filePath, offset) {
  let incomingSourceMap = fs.readFileSync(filePath, 'utf-8');
  incomingSourceMap = JSON.parse(incomingSourceMap);
  var consumer = await new sourceMap.SourceMapConsumer(incomingSourceMap);
  var generator = await new sourceMap.SourceMapGenerator({
      file: incomingSourceMap.file,
      sourceRoot: incomingSourceMap.sourceRoot
  });
  consumer.eachMapping(function (m) {
    if (typeof m.originalLine === 'number' && 0 < m.originalLine &&
        typeof m.originalColumn === 'number' && 0 <= m.originalColumn &&
        m.source) {
        generator.addMapping({
            source: m.source,
            name: m.name,
            original: { line: m.originalLine, column: m.originalColumn },
            generated: { line: m.generatedLine, column: m.generatedColumn + offset}
        });
    }
  });
  var outgoingSourceMap = JSON.parse(generator.toString());
  if (typeof incomingSourceMap.sourcesContent !== 'undefined') {
      outgoingSourceMap.sourcesContent = incomingSourceMap.sourcesContent;
  }
  outgoingSourceMap = JSON.stringify(outgoingSourceMap)
  fs.writeFileSync(filePath, outgoingSourceMap);
  return;
};

global.bytenode = {
  compileCode, compileFile, compileElectronCode,
  runBytecode, runBytecodeFile,
  addLoaderFile, loaderCode
};

module.exports = global.bytenode;
