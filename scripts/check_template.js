const fs = require('fs');
const html = fs.readFileSync('frontend/dist/index.html', 'utf8');
const lines = html.split('\n');
let inScript = false;
let lineCount = 0;
const oddLines = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('<script type="text/babel">')) { inScript = true; continue; }
  if (inScript && line.trim() === '</script>') break;
  if (!inScript) continue;
  lineCount++;
  
  let count = 0;
  let inSingle = false, inDouble = false, inBack = false;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (!inDouble && !inBack) {
      if (c === "'" && line[j-1] !== '\\') inSingle = !inSingle;
    }
    if (!inSingle && !inBack) {
      if (c === '"' && line[j-1] !== '\\') inDouble = !inDouble;
    }
    if (!inSingle && !inDouble) {
      if (c === '`') { count++; inBack = !inBack; }
    }
  }
  if (count % 2 === 1) {
    oddLines.push({ htmlLine: i+1, scriptLine: lineCount, count, content: line.substring(0, 300) });
  }
}

if (oddLines.length === 0) {
  console.log('✅ 每行内的反引号数量都是偶数（仅检查行内，未考虑跨行）');
} else {
  console.log('⚠️  以下行在行内有奇数个反引号（可能跨行是正常的，但重点检查）：');
  oddLines.forEach(l => {
    console.log(`  HTML#${l.htmlLine} 脚本#${l.scriptLine} (count=${l.count}): ${l.content}`);
  });
}

// 额外：检查所有模板字符串的配对（简单方法：全局追踪状态）
console.log('\n--- 全局追踪模板字符串状态 ---');
inScript = false;
let inBackTick = false;
let lineNo = 0;
const opens = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('<script type="text/babel">')) { inScript = true; continue; }
  if (inScript && line.trim() === '</script>') break;
  if (!inScript) continue;
  lineNo++;
  
  let inSingle = false, inDouble = false;
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (!inDouble) {
      if (c === "'" && line[j-1] !== '\\') inSingle = !inSingle;
    }
    if (!inSingle) {
      if (c === '"' && line[j-1] !== '\\') inDouble = !inDouble;
    }
    if (!inSingle && !inDouble && c === '`') {
      inBackTick = !inBackTick;
      if (inBackTick) {
        opens.push({ scriptLine: lineNo, col: j+1, snippet: line.substring(j, Math.min(j+40, line.length)) });
      } else {
        const last = opens.pop();
        if (last) {
          // console.log(`  模板 ${last.scriptLine}:${last.col} -> ${lineNo}:${j+1}`);
        }
      }
    }
  }
}

if (opens.length > 0) {
  console.log('❌ 未关闭的模板字符串：', opens.length, '个');
  opens.forEach(o => console.log(`  脚本行#${o.scriptLine} 列${o.col}: ${o.snippet}`));
} else {
  console.log('✅ 所有模板字符串都正确关闭');
}
