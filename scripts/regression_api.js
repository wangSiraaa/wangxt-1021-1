var http = require('http');
var PORT = 3011;

var pass = 0;
var fail = 0;
var results = [];

function api(method, path, body, cb) {
  var postData = body ? JSON.stringify(body) : null;
  var opts = {hostname:'localhost', port:PORT, path:path, method:method,
    headers:{'Content-Type':'application/json'}};
  if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);
  var req = http.request(opts, function(res){
    var data = '';
    res.on('data', function(c){ data += c; });
    res.on('end', function(){
      try { cb(null, {status:res.statusCode, body:JSON.parse(data)}); }
      catch(e){ cb(null, {status:res.statusCode, raw:data}); }
    });
  });
  req.on('error', function(e){ cb(e); });
  if (postData) req.write(postData);
  req.end();
}

function check(name, cond, detail) {
  if (cond) { pass++; results.push('  ✅ ' + name); }
  else { fail++; results.push('  ❌ ' + name + ' - ' + (detail||'')); }
}

function section(title) { results.push(''); results.push('📋 ' + title); }

// ========== 测试：游客预约 ==========
section('1️⃣  游客预约');

// 1.1 查时段容量
api('GET', '/api/admin/time-slots', null, function(e, r){
  check('时段容量查询', !e && r.status===200 && r.body.code===0 && Array.isArray(r.body.data),
    e ? e.message : (r.body?(r.body.code+' '+r.body.message):('status='+r.status)));
  var slots = r.body && r.body.data ? r.body.data.filter(function(s){return s.status==='AVAILABLE';}) : [];
  var slotId = slots[0] ? slots[0].id : 1;
  check('时段列表非空', slots.length > 0, '可用时段数='+slots.length);

  // 1.2 查采摘券
  api('GET', '/api/admin/picking-tickets', null, function(e2, r2){
    check('采摘券查询', !e2 && r2.status===200 && r2.body.code===0 && Array.isArray(r2.body.data),
      e2 ? e2.message : (r2.body?(r2.body.code+' '+r2.body.message):('status='+r2.status)));
    var tickets = r2.body && r2.body.data ? r2.body.data.filter(function(t){return t.status==='ACTIVE';}) : [];
    var ticketId = tickets[0] ? tickets[0].id : 1;
    check('采摘券列表非空', tickets.length > 0, '有效券数='+tickets.length);

    // 1.3 创建预约
    var reservation = {
      visitor_name: 'API测试游客' + (Date.now()%10000),
      visitor_phone: '139' + String(10000000 + Math.floor(Math.random()*89999999)),
      visitor_type: 'ADULT',
      slot_id: slotId,
      ticket_id: ticketId,
      group_size: 2,
      adult_count: 2,
      child_count: 0,
      remark: 'API回归测试'
    };
    api('POST', '/api/reservations', reservation, function(e3, r3){
      check('创建预约', !e3 && r3.status===200 && r3.body.code===0,
        e3 ? e3.message : (r3.body?(r3.body.code+' '+r3.body.message):('status='+r3.status)));
      var resId = r3.body && r3.body.data && r3.body.data.id;
      var resNo = r3.body && r3.body.data && r3.body.data.reservation_no;
      check('预约返回字段完整', !!resId && !!resNo, 'id='+resId+', no='+resNo);

      // 1.4 查询预约
      if (resId) {
        api('GET', '/api/reservations/' + resId, null, function(e4, r4){
          check('查询预约详情', !e4 && r4.status===200 && r4.body.code===0,
            e4 ? e4.message : (r4.body?(r4.body.code+' '+r4.body.message):''));

          onsiteTests(resId, resNo);
        });
      } else {
        onsiteTests(null, null);
      }
    });
  });
});

// ========== 测试：现场核销 ==========
function onsiteTests(resId, resNo) {
  section('2️⃣  现场核销');

  // 2.1 查入园记录(确保接口可用)
  api('GET', '/api/onsite/entry-records', null, function(e, r){
    check('入园记录接口', !e && r.status===200 && r.body.code===0,
      e ? e.message : (r.body?(r.body.code+' '+r.body.message):''));

    // 2.2 如果有预约ID，执行入园核销
    if (resId) {
      api('POST', '/api/onsite/entry', {reservation_id: resId}, function(e2, r2){
        check('入园核销', !e2 && r2.status===200 && r2.body.code===0,
          e2 ? e2.message : (r2.body?(r2.body.code+' '+r2.body.message):''));
        var entryId = r2.body && r2.body.data && r2.body.data.entry_record_id;
        check('入园记录ID返回', !!entryId, 'entryId='+entryId);

        // 2.3 更新采摘进度
        if (entryId) {
          api('PUT', '/api/onsite/entry/' + entryId + '/progress',
            {progress_percent: 35, picked_weight: 3.2},
            function(e3, r3){
              check('采摘进度更新', !e3 && r3.status===200 && r3.body.code===0,
                e3 ? e3.message : (r3.body?(r3.body.code+' '+r3.body.message):''));

              closureTests();
              refundTests(resId, entryId);
            });
        } else {
          closureTests();
          refundTests(resId, null);
        }
      });
    } else {
      closureTests();
      refundTests(null, null);
    }
  });
}

// ========== 测试：闭园看板 ==========
function closureTests() {
  section('3️⃣  闭园看板');

  api('GET', '/api/dashboard/closure-status', null, function(e, r){
    check('闭园看板接口', !e && r.status===200 && r.body.code===0,
      e ? e.message : (r.body?(r.body.code+' '+r.body.message):''));
    check('闭园看板含时段/预警字段',
      (r.body.data && (r.body.data.closure_slots || r.body.data.closures || r.body.data.alerts)) ? true : false,
      r.body.data ? 'keys='+JSON.stringify(Object.keys(r.body.data)) : '无data');
  });

  api('GET', '/api/dashboard/overview', null, function(e, r){
    check('总览看板接口', !e && r.status===200 && r.body.code===0,
      e ? e.message : (r.body?(r.body.code+' '+r.body.message):''));
  });
}

// ========== 测试：退款试算 ==========
function refundTests(resId, entryId) {
  section('4️⃣  退款试算');

  api('GET', '/api/dashboard/refund-records', null, function(e, r){
    check('退款记录看板', !e && r.status===200 && r.body.code===0,
      e ? e.message : (r.body?(r.body.code+' '+r.body.message):''));
  });

  if (resId) {
    // 退款试算(入园后/按进度)
    api('POST', '/api/reservations/' + resId + '/refund-preview',
      {reason: 'USER_CANCEL', extraWeightCharge: 0, damageCharge: 0},
      function(e, r){
        check('退款试算接口', !e && r.status===200 && r.body.code===0,
          e ? e.message : (r.body?(r.body.code+' '+r.body.message):''));
        check('试算含退款金额',
          (r.body.data && (typeof r.body.data.refund_amount !== 'undefined' || typeof r.body.data.totalRefund !== 'undefined')) ? true : false,
          r.body.data ? 'keys='+JSON.stringify(Object.keys(r.body.data)).substring(0,100) : '无data');

        summary();
      });
  } else {
    summary();
  }
}

function summary() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           🍎  API 回归测试 结果汇总                        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  results.forEach(function(l){
    var pad = 57 - l.length;
    if (pad < 0) pad = 0;
    console.log('║ ' + l + (new Array(pad+1).join(' ')) + '║');
  });
  console.log('╠══════════════════════════════════════════════════════════╣');
  var status = fail===0 ? '✅ 全部通过' : '❌ 部分失败';
  var total = pass + fail;
  console.log('║  总计: '+total+'   ✅通过: '+pass+'   ❌失败: '+fail+'   '+status+'    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  process.exit(fail===0 ? 0 : 1);
}
