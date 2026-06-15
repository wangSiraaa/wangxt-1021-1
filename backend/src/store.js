const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'fruit_picking.json');

class DataStore {
  constructor() {
    this.data = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      this.data = JSON.parse(raw);
    } catch (e) {
      console.error('加载数据文件失败:', e.message);
      this.data = this._getEmptyData();
    }
  }

  _getEmptyData() {
    return {
      orchard_zone: [],
      maturity_version: [],
      time_slot: [],
      weather_alert: [],
      picking_ticket: [],
      visitor_blacklist: [],
      reservation: [],
      deposit_record: [],
      entry_record: [],
      closure_record: [],
      refund_record: [],
      exception_record: [],
      waitlist: [],
      batch_entry: [],
      addon_service: [],
      addon_order: [],
      reschedule_record: [],
      family_member: [],
      weight_adjust_log: [],
      on_site_extra: [],
      state_sync_log: []
    };
  }

  save() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存数据文件失败:', e.message);
    }
  }

  getAll(tableName) {
    return this.data[tableName] || [];
  }

  getById(tableName, id) {
    return this.data[tableName]?.find(r => r.id === id) || null;
  }

  findOne(tableName, predicate) {
    return this.data[tableName]?.find(predicate) || null;
  }

  find(tableName, predicate) {
    return this.data[tableName]?.filter(predicate) || [];
  }

  insert(tableName, record) {
    if (!this.data[tableName]) {
      this.data[tableName] = [];
    }
    const maxId = this.data[tableName].reduce((max, r) => Math.max(max, r.id || 0), 0);
    record.id = maxId + 1;
    record.created_at = this._now();
    record.updated_at = this._now();
    this.data[tableName].push(record);
    this.save();
    return record;
  }

  update(tableName, id, updates) {
    const idx = this.data[tableName]?.findIndex(r => r.id === id) ?? -1;
    if (idx === -1) return null;
    this.data[tableName][idx] = { ...this.data[tableName][idx], ...updates, updated_at: this._now() };
    this.save();
    return this.data[tableName][idx];
  }

  updateWhere(tableName, predicate, updates) {
    if (!this.data[tableName]) return 0;
    let count = 0;
    this.data[tableName] = this.data[tableName].map(r => {
      if (predicate(r)) {
        count++;
        return { ...r, ...updates, updated_at: this._now() };
      }
      return r;
    });
    if (count > 0) this.save();
    return count;
  }

  delete(tableName, id) {
    const idx = this.data[tableName]?.findIndex(r => r.id === id) ?? -1;
    if (idx === -1) return false;
    this.data[tableName].splice(idx, 1);
    this.save();
    return true;
  }

  deleteWhere(tableName, predicate) {
    if (!this.data[tableName]) return 0;
    const before = this.data[tableName].length;
    this.data[tableName] = this.data[tableName].filter(r => !predicate(r));
    const deleted = before - this.data[tableName].length;
    if (deleted > 0) this.save();
    return deleted;
  }

  _now() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

module.exports = new DataStore();
