// Restore the error location according to SourceMap
const sourceMap = require('source-map');
const fs = require('fs');
const SourceMapConsumer = sourceMap.SourceMapConsumer;

const line = parseInt(process.argv[2]);
const column = parseInt(process.argv[3]);

const sourceMapFileContent = fs.readFileSync(__dirname + '/hello.min.js.map');
const sourceMapContent = JSON.parse(sourceMapFileContent);

(async function() {
  const consumer = await new SourceMapConsumer(sourceMapContent);

  const originalPosition = consumer.originalPositionFor({
      line,
      column,
  });
  
  console.log("【Error locate】")
  console.log(originalPosition);
})()
