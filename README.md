# Bytenode
compileFile: generate dummycode contained line break
```
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
```
if compiledAsModule, sourcemap needs to be modifyed
```
if (compileAsModule) {
  code = Module.wrap(javascriptCode.replace(/^#!.*/, ''));

  // Rebuild sourcemap to locate error correctly
  let mapFilename = filename + '.map';
  if (compileAsModule && fs.existsSync(mapFilename)) {
    const offset = '(function (exports, require, module, __filename, __dirname) { ';
    await rebuildSourmap(mapFilename, offset.length);
    console.log("Rebuild sourcemap!")
  }
}
```

runBytecode: restore location information from dummycode
```
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
```
## example
See the test folder for an example

