// 运行时设置持久化：写入 data/settings.json
// 用于「本地音乐文件夹」等可在前端设置页修改、且不随代码提交的配置
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'settings.json');

// 启动时载入已有配置；文件不存在或损坏时使用空对象
let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  data = {};
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 写入失败: ' + e.message);
  }
}

module.exports = {
  get: (key, def) => (key in data ? data[key] : def),
  set: (key, value) => {
    data[key] = value;
    save();
  },
  all: () => ({ ...data })
};
