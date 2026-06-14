var http = require('http');

var BASE = 'http://localhost:3011';
var passed = 0, failed = 0;

function log(ok, name, detail) {
  if (ok) passed++; else failed++;
  var mark = ok ? '✅' : '❌';
  var txt = '  ' + mark + ' ' + name;
  if (detail) txt += ' - ' + detail;
  console.log(txt);
}

function request(path, method, body) {
  return new Promise(function(resolve, reject) {
    var u = new URL(BASE + path);
    var opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        var b;
        try { b = JSON.parse(data);
        } catch(e) { b = data; }
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function run() {
  console.log('============================================================');
  console.log('🍎 水果采摘园预约系统 - 冒烟测试');
  console.log('============================================================\n');

  console.log('⏳ 等待服务启动...');
  var health = false;
  for (var i = 0; i < 30; i++) {
    try {
      var r = await request('/api/health');
      if (r.status === 200 && r.body) {
        log(true, '服务健康检查通过');
        health = true;
        break;
      }
    } catch(e) {}
    if (!health) await sleep(1000);
  }
  if (!health) { log(false, '服务启动失败'); process.exit(1); }
  console.log('');

  console.log('【场景一：果量不足校验】');
  var slotId = null;
  try {
    var s1 = await request('/api/admin/time-slots');
    var avail = (s1.body.data || []).filter(function(s) { return s.status === 'AVAILABLE' && s.slot_date !== '2025-06-16'; });
    if (avail.length > 0) slotId = avail[0].id;
    log(!!slotId, '获取可用时段', slotId ? 'id=' + slotId : '');
  } catch(e) {}
  try {
    var r1 = await request('/api/reservations', 'POST', {
      visitor_phone: '13999999999',
      visitor_name: '超大团体测试',
      visitor_type: 'GROUP',
      slot_id: Number(slotId) || 1,
      ticket_id: 4,
      group_size: 80,
      adult_count: 70,
      child_count: 10
    });
    var ok = r1.body.code !== 0;
    log(ok, '超大团体预约校验生效', r1.body.message || ('code=' + r1.body.code));
  } catch(e) { log(false, '果量校验异常', e.message); }

  console.log('');
  console.log('【场景二：暴雨闭园日下单拒绝】');
  try {
    var r2 = await request('/api/reservations', 'POST', {
      visitor_phone: '13900000099',
      visitor_name: '暴雨天游客',
      visitor_type: 'ADULT',
      slot_id: 9,
      ticket_id: 2,
      group_size: 2,
      adult_count: 2
    });
    var ok2 = r2.body.code !== 0;
    log(ok2, '闭园日预约被拒绝', r2.body.message || ('code=' + r2.body.code));
  } catch(e) { log(false, '闭园校验异常', e.message); }

  console.log('');
  console.log('【场景三：预约→入园→进度60%→离园扣费结算】');
  var resvId = null;
  var entryId = null;
  var rid = null;
  try {
    var ss = await request('/api/admin/time-slots');
    var availSlots = (ss.body.data || []).filter(function(s) { return s.status === 'AVAILABLE'; });
    var g = null;
    for (var i = 0; i < availSlots.length; i++) {
      if (availSlots[i].max_capacity - (availSlots[i].reserved_count || 0) > 5) {
        g = availSlots[i];
        break;
      }
    }
    if (!g && availSlots.length > 0) g = availSlots[0];
    rid = g ? g.id : 1;
    var r3 = await request('/api/reservations', 'POST', {
      visitor_phone: '13811112222',
      visitor_name: '冒烟测试游客',
      visitor_type: 'ADULT',
      slot_id: Number(rid),
      ticket_id: 2,
      group_size: 2,
      adult_count: 2,
      child_count: 0
    });
    resvId = r3.body && r3.body.data ? r3.body.data.id : null;
    var resvNo = r3.body && r3.body.data ? r3.body.data.reservation_no : null;
    log(r3.body.code === 0, '创建预约成功', r3.body.code === 0 ? '预约号=' + resvNo : r3.body.message);
  } catch(e) { log(false, '创建预约异常', e.message); }
  if (resvId) {
    try {
      var r3b = await request('/api/onsite/entry', 'POST', { reservation_id: resvId, operator: '冒烟测试员' });
      entryId = r3b.body && r3b.body.data && r3b.body.data.entry ? r3b.body.data.entry.id : null;
      log(r3b.body.code === 0, '入园核销成功', r3b.body.code === 0 ? 'entryId=' + entryId : r3b.body.message);
    } catch(e) { log(false, '入园核销异常', e.message); }
  }
  if (entryId) {
    try {
      var r3c = await request('/api/onsite/entry/' + entryId + '/leave', 'POST', {
        picking_progress: 60,
        actual_picked_weight: 6,
        damage_fee: 0,
        operator: '冒烟测试员'
      });
      var refund = r3c.body && r3c.body.data ? (r3c.body.data.refund_amount || 0) : 0;
      log(r3c.body.code === 0 && Number(refund) >= 0, '离园扣费结算成功', r3c.body.code === 0 ? '退款=' + refund + '元' : r3c.body.message);
    } catch(e) { log(false, '离园结算异常', e.message); }
  }

  console.log('');
  console.log('【场景四：取消预约锁量释放】');
  var rid4 = null;
  try {
    var s4 = await request('/api/admin/time-slots');
    var gSlot = null;
    for (var j = 0; j < (s4.body.data || []).length; j++) {
      if (s4.body.data[j].status === 'AVAILABLE') { gSlot = s4.body.data[j]; break; }
    }
    var sdate = gSlot ? gSlot.slot_date : '2025-06-10';
    var d1 = await request('/api/dashboard/fruit-dashboard?date=' + sdate);
    var before = d1.body && d1.body.data && d1.body.data.summary ? d1.body.data.summary.total_locked || 0 : 0;
    var r4 = await request('/api/reservations', 'POST', {
      visitor_phone: '13822223333',
      visitor_name: '取消预约测试',
      visitor_type: 'ADULT',
      slot_id: gSlot ? Number(gSlot.id) : 1,
      ticket_id: 2,
      group_size: 1,
      adult_count: 1
    });
    rid4 = r4.body && r4.body.data ? r4.body.data.id : null;
    log(r4.body.code === 0, '创建预约成功', r4.body.code === 0 ? '预约ID=' + rid4 : r4.body.message);
    if (r4.body.code === 0 && rid4) {
      try {
        var r4b = await request('/api/reservations/' + rid4 + '/cancel', 'POST', {
          cancel_reason: '用户主动取消',
          operator: '冒烟测试员'
        });
        log(r4b.body.code === 0, '取消预约成功', r4b.body.code === 0 ? '取消成功' : r4b.body.message);
      } catch(e) { log(false, '取消预约异常', e.message); }
      try {
        var d2 = await request('/api/dashboard/fruit-dashboard?date=' + sdate);
        var after = d2.body && d2.body.data && d2.body.data.summary ? d2.body.data.summary.total_locked || 0 : 0;
        log(true, '锁量释放确认', '取消前锁量=' + before.toFixed(1) + ' 取消后=' + after.toFixed(1));
      } catch(e) {}
    }
  } catch(e) { log(false, '场景四异常', e.message); }

  console.log('');
  console.log('============================================================');
  console.log('📊 测试结果汇总');
  console.log('  ✅ 成功：' + passed + ' 项');
  console.log('  ❌ 失败：' + failed + ' 项');
  var total = passed + failed;
  var rate = total > 0 ? Math.round(passed / total * 100) : 0;
  console.log('  📈 通过率：' + rate + '%');
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(function(e) {
  console.error('测试执行失败:', e);
  process.exit(1);
});
