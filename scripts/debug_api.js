var http = require('http');
var PORT = 3011;

function api(method, path, body, cb) {
  var postData = body ? JSON.stringify(body) : null;
  var opts = {hostname:'localhost', port:PORT, path:path, method:method,
    headers:{'Content-Type':'application/json'}};
  if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);
  var req = http.request(opts, function(res){
    var data = '';
    res.on('data', function(c){ data += c; });
    res.on('end', function(){
      try { cb(null, {status:res.statusCode, body:JSON.parse(data), raw:data}); }
      catch(e){ cb(null, {status:res.statusCode, raw:data}); }
    });
  });
  req.on('error', function(e){ cb(e); });
  if (postData) req.write(postData);
  req.end();
}

// 测试1: 时段容量
console.log('=== 测试1: 时段容量 ===');
api('GET', '/api/reservations/time-slots?date=2026-06-17', null, function(e, r){
  console.log('status:', r.status);
  console.log('keys:', r.body ? Object.keys(r.body) : 'no body');
  console.log('data type:', r.body && r.body.data ? typeof r.body.data + ' Array=' + Array.isArray(r.body.data) : 'no data');
  console.log('body preview:', JSON.stringify(r.body).substring(0, 300));
  console.log('');

  // 测试2: 采摘券
  console.log('=== 测试2: 采摘券 ===');
  api('GET', '/api/reservations/available-tickets?date=2026-06-17', null, function(e2, r2){
    console.log('status:', r2.status);
    console.log('keys:', r2.body ? Object.keys(r2.body) : 'no body');
    console.log('data type:', r2.body && r2.body.data ? typeof r2.body.data + ' Array=' + Array.isArray(r2.body.data) : 'no data');
    console.log('body preview:', JSON.stringify(r2.body).substring(0, 300));
    console.log('');

    // 测试3: 创建预约 - 先看看需要什么参数
    console.log('=== 测试3: 查后端路由看创建预约参数要求 ===');
    api('GET', '/api/reservations/time-slots?date=2026-06-17', null, function(e3, r3){
      var slotId = (r3.body && r3.body.data && r3.body.data[0] && r3.body.data[0].id) || 1;
      var ticketType = (r2.body && r2.body.data && r2.body.data[0] && r2.body.data[0].ticket_type) || 'ADULT';

      console.log('slotId:', slotId, 'ticketType:', ticketType);

      var reservation = {
        reservation_date: '2026-06-17',
        slot_id: slotId,
        visitor_name: '测试游客',
        visitor_phone: '138' + String(10000000 + Math.floor(Math.random()*89999999)),
        visitor_type: 'ADULT',
        ticket_type: ticketType,
        total_people: 2,
        adults_count: 2,
        children_count: 0,
        notes: 'debug test'
      };
      console.log('reservation payload:', JSON.stringify(reservation));
      api('POST', '/api/reservations', reservation, function(e4, r4){
        console.log('status:', r4.status);
        console.log('response:', r4.raw ? r4.raw.substring(0, 600) : '');
        console.log('');

        // 测试4: 搜索预约
        if (r4.body && r4.body.data && r4.body.data.reservation_no) {
          console.log('=== 测试4: 搜索预约 ===');
          var q = '/api/onsite/reservations/search?keyword=' + r4.body.data.reservation_no;
          api('GET', q, null, function(e5, r5){
            console.log('status:', r5.status);
            console.log('response:', JSON.stringify(r5.body).substring(0, 300));
          });
        }
      });
    });
  });
});
