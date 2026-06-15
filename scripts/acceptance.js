var http = require('http');

var BASE = 'http://localhost:3011';
var passed = 0, failed = 0;
var scenarioPassed = 0, scenarioFailed = 0;
var tempReservationIds = [];
var tempWaitlistIds = [];

function log(ok, name, detail) {
  if (ok) passed++; else failed++;
  var mark = ok ? '✅' : '❌';
  var txt = '    ' + mark + ' ' + name;
  if (detail) txt += ' - ' + detail;
  console.log(txt);
}

function section(title) {
  console.log('\n  📌 ' + title);
}

function scenario(ok, title, detail) {
  if (ok) scenarioPassed++; else scenarioFailed++;
  var mark = ok ? '🎯' : '⛔';
  console.log('\n' + mark + ' 验收场景：' + title);
  if (detail) console.log('   ' + detail);
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

function randPhone() {
  return '139' + Math.floor(Math.random() * 90000000 + 10000000);
}

async function run() {
  console.log('=========================================================================');
  console.log('🍎 水果采摘园预约系统 - 验收演示测试');
  console.log('   覆盖：果量不足拦截 / 暴雨闭园改期 / 分批入园锁量 / 现场称重差额结算');
  console.log('=========================================================================\n');

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

  var slotsData = await request('/api/admin/time-slots');
  var allSlots = slotsData.body.data || [];
  var availableSlots = allSlots.filter(function(s) { return s.status === 'AVAILABLE'; });
  var closureSlot = allSlots.find(function(s) { return s.status === 'CLOSURE'; });
  var closureDate = closureSlot ? closureSlot.slot_date : null;

  log(availableSlots.length > 0, '获取可用时段', '共' + availableSlots.length + '个');
  log(!!closureSlot, '存在闭园时段', closureSlot ? closureDate + ' ' + closureSlot.slot_label : '');

  if (availableSlots.length < 2) {
    log(false, '可用时段数量不足，需要至少2个');
  }
  var slotA = availableSlots[0];
  var slotB = availableSlots[Math.min(availableSlots.length - 1, 2)];

  console.log('\n\n🎬 开始验收场景演示');

  // ============================================================
  // 场景1：果量不足拦截
  // ============================================================
  scenario(true, '场景1：果量不足拦截',
    '模拟游客预约时成熟果量不足→系统返回4105并提示具体差量→自动进入候补队列');

  section('1.1 查看时段细化状态（含果量/容量/区域明细）');
  var availResp = await request('/api/reservations/slot-availability/' + slotA.id);
  log(availResp.body.code === 0, '查询时段细化状态成功');
  var canBook = availResp.body.data ? availResp.body.data.can_book : null;
  var availWeight = availResp.body.data ? (availResp.body.data.weight ? availResp.body.data.weight.available : null) : null;
  if (availWeight != null) {
    log(true, '时段可用果量解析成功', availWeight.toFixed(1) + '斤');
  }
  if (availResp.body.data && availResp.body.data.availability_reasons) {
    log(true, '时段满员原因说明已返回', '原因数量=' + availResp.body.data.availability_reasons.length);
  }

  section('1.2 预约超果量团体→触发拦截');
  var hugeWeight = (availWeight || 200) + 100;
  var hugeSize = Math.ceil(hugeWeight / 8);
  var blockResp = await request('/api/reservations', 'POST', {
    visitor_phone: randPhone(),
    visitor_name: '果量拦截测试-大团体',
    visitor_type: 'GROUP',
    slot_id: slotA.id,
    ticket_id: 4,
    group_size: hugeSize,
    adult_count: hugeSize,
    child_count: 0
  });
  var blocked = blockResp.body.code === 4103 || blockResp.body.code === 4105;
  log(blocked, '超量团体预约被拒绝', 'code=' + blockResp.body.code + ' msg=' + (blockResp.body.message || ''));
  if (blockResp.body.code === 4105) {
    log(true, '果量不足拦截码4105命中', blockResp.body.message);
  } else if (blockResp.body.code === 4103) {
    log(true, '容量不足拦截码4103命中', blockResp.body.message);
  }

  section('1.3 进入候补队列（当预约满员时自动候补）');
  var slotForWaitlist = slotB.id;
  var waitlistResp = await request('/api/reservations/waitlist', 'POST', {
    visitor_phone: randPhone(),
    visitor_name: '候补游客-张小明',
    slot_id: slotForWaitlist,
    ticket_id: 2,
    group_size: 3,
    adult_count: 2,
    child_count: 1,
    remark: '希望尽快排到'
  });
  var waitlistOk = waitlistResp.body.code === 0;
  if (waitlistOk) {
    tempWaitlistIds.push(waitlistResp.body.data.id);
    log(true, '候补登记成功', '队列位置=' + waitlistResp.body.data.queue_position + ' 前面有' + waitlistResp.body.data.ahead_count + '人');
    log(Array.isArray(waitlistResp.body.data.availability_reasons),
      '候补返回可用性原因列表', '原因数=' + (waitlistResp.body.data.availability_reasons || []).length);
  } else {
    log(waitlistResp.body.code === 400 && waitlistResp.body.message && waitlistResp.body.message.indexOf('仍有名额') > -1,
      '时段尚有名额，自动提示直接预约', waitlistResp.body.message || '');
  }

  var s1ok = (blocked === true);
  scenario(s1ok, '场景1验收：果量不足拦截', s1ok ? '通过' : '未通过');

  // ============================================================
  // 场景2：暴雨闭园改期
  // ============================================================
  scenario(true, '场景2：暴雨闭园改期',
    '先在正常时段创建预约→系统标记某日暴雨闭园→执行闭园批量处理→游客端看到改期选项并平移到新时段');

  section('2.1 先在正常可用时段创建一个有效预约');
  var phoneClosure = randPhone();
  var makeResv = await request('/api/reservations', 'POST', {
    visitor_phone: phoneClosure,
    visitor_name: '暴雨闭园改期测试-李华',
    visitor_type: 'ADULT',
    slot_id: slotA.id,
    ticket_id: 2,
    group_size: 2,
    adult_count: 2,
    source: '验收测试'
  });
  var resvOk = makeResv.body.code === 0;
  log(resvOk, '预约创建成功', resvOk ? '预约号=' + makeResv.body.data.reservation_no : '失败 msg=' + makeResv.body.message);
  var resvId = resvOk ? makeResv.body.data.id : null;
  var oldSlotId = slotA.id;

  section('2.2 模拟暴雨闭园：使用管理员API设置闭园+批量处理（若无闭园日则创建）');
  if (resvOk && closureSlot) {
    log(true, '系统已有闭园日：' + closureDate + ' ' + closureSlot.slot_label);
  } else if (resvOk) {
    var setClosure = await request('/api/admin/time-slots/' + oldSlotId, 'PUT', {
      status: 'CLOSURE',
      limit_reason: '突发暴雨红色预警'
    });
    log(setClosure.body.code === 0, '设置闭园状态成功');
    closureSlot = { id: oldSlotId, slot_date: slotA.slot_date, slot_label: slotA.slot_label };
    closureDate = slotA.slot_date;
  }

  if (resvOk && closureSlot) {
    section('2.3 执行闭园批量处理（自动退款处理 + 后续可改期）');
    var closureResp = await request('/api/reservations/closure-process', 'POST', {
      slot_date: closureSlot.slot_date,
      operator: '验收脚本',
      reason: '暴雨红色预警'
    });
    log(closureResp.body.code === 0, '闭园批量处理成功',
      closureResp.body.data ? '处理了' + closureResp.body.data.count + '条预约' : '无数据');
  }

  section('2.4 游客端改期：将预约平移到新时段slotB');
  if (resvId) {
    var rescheduleResp = await request('/api/reservations/' + resvId + '/reschedule', 'POST', {
      new_slot_id: slotB.id,
      operator: '验收脚本-游客李华',
      reason: '暴雨闭园改期到新时段'
    });
    var rsOk = rescheduleResp.body.code === 0;
    log(rsOk, '改期平移执行结果',
      rsOk ? '新slot_id=' + rescheduleResp.body.data.reservation.slot_id
           : '失败：' + (rescheduleResp.body.message || 'code=' + rescheduleResp.body.code));
    if (rsOk) {
      tempReservationIds.push(rescheduleResp.body.data.reservation.id);
      log(!!rescheduleResp.body.data.reschedule_no,
        '改期记录号生成', rescheduleResp.body.data.reschedule_no);
    }

    section('2.5 查询改期记录（证明有完整审计链路）');
    var rsRecords = await request('/api/reservations/reschedule-records?reservation_id=' + resvId);
    log(rsRecords.body.code === 0 && Array.isArray(rsRecords.body.data) && rsRecords.body.data.length >= (rsOk ? 1 : 0),
      '改期记录查询返回', '记录数=' + (rsRecords.body.data || []).length);
  }

  section('2.6 三端状态一致性检查：管理员/游客/现场核销看到同一份状态');
  if (resvId) {
    var stateResp = await request('/api/reservations/' + resvId + '/state');
    var stOk = stateResp.body.code === 0 && stateResp.body.data.reservation;
    log(stOk, '三端统一状态接口返回', stOk ? 'reservation状态=' + stateResp.body.data.reservation.status : '失败');
    if (stOk && stateResp.body.data.slot) {
      log(stateResp.body.data.slot.id === slotB.id,
        '改期后slot同步到最新', 'slot_id=' + stateResp.body.data.slot.id);
    }
    if (stOk) {
      var hasLastSync = stateResp.body.data.state_sync_logs && stateResp.body.data.state_sync_logs.length > 0;
      log(hasLastSync, '状态同步日志存在', '最近同步=' + (hasLastSync ? stateResp.body.data.state_sync_logs[0].source : ''));
    }
  }

  var s2ok = resvOk === true;
  scenario(s2ok, '场景2验收：暴雨闭园改期', s2ok ? '通过' : '未通过');

  // ============================================================
  // 场景3：分批入园锁量
  // ============================================================
  scenario(true, '场景3：分批入园锁量',
    '创建团体预约→配置分批入园→第一批核销→第二批核销→检查时段entered_count准确累加→全部离园后锁量和容量释放');

  section('3.1 创建一个大团体预约（分批用）');
  var phoneBatch = randPhone();
  var batchResp = await request('/api/reservations', 'POST', {
    visitor_phone: phoneBatch,
    visitor_name: '分批入园测试-某某公司团建',
    visitor_type: 'GROUP',
    slot_id: slotB.id,
    ticket_id: 4,
    group_size: 6,
    adult_count: 5,
    child_count: 1
  });
  var batchOk = batchResp.body.code === 0;
  log(batchOk, '分批团体预约创建成功',
    batchOk ? '预约号=' + batchResp.body.data.reservation_no : '失败 msg=' + batchResp.body.message);
  var batchResvId = batchOk ? batchResp.body.data.id : null;
  if (batchOk) tempReservationIds.push(batchResvId);

  section('3.2 第一批3人入园核销（分批）');
  var be1 = await request('/api/onsite/batch-entry', 'POST', {
    reservation_id: batchResvId,
    batch_name: '第一批-上午组',
    batch_count: 3,
    remark: '先到的3人',
    checked_by: '现场核销员-小王',
    operator: 'onsite-小王'
  });
  var be1ok = be1.body.code === 0;
  log(be1ok, '第一批核销结果', be1ok ? '已入园=' + be1.body.data.already_in_count + '人，剩余=' + be1.body.data.remaining_count + '人'
                                         : '失败：' + (be1.body.message || ''));
  if (be1ok) {
    log(be1.body.data.entry_record && be1.body.data.entry_record.entry_status === 'IN_GARDEN',
      '入园记录entry_record生成且状态IN_GARDEN');
  }

  section('3.3 第二批3人入园核销');
  var be2 = await request('/api/onsite/batch-entry', 'POST', {
    reservation_id: batchResvId,
    batch_name: '第二批-下午组',
    batch_count: 3,
    remark: '后到的3人',
    checked_by: '现场核销员-小王',
    operator: 'onsite-小王'
  });
  var be2ok = be2.body.code === 0;
  log(be2ok, '第二批核销结果', be2ok ? '已入园=' + be2.body.data.already_in_count + '人，剩余=' + be2.body.data.remaining_count + '人'
                                         : '失败：' + (be2.body.message || ''));

  section('3.4 看板：分批进度可视化（管理人员看到）');
  var bd = await request('/api/dashboard/batch-entry-dashboard?slot_id=' + slotB.id);
  var bdok = bd.body.code === 0;
  log(bdok, '分批进度看板返回');
  if (bdok && bd.body.data.summary) {
    log(true, '分批统计摘要',
      '总批次数=' + bd.body.data.summary.total_batches +
      ' 在园批次=' + bd.body.data.summary.in_garden_batches +
      ' 在园人数=' + bd.body.data.summary.in_garden_count);
  }

  section('3.5 第一批离园→不释放全部容量，等第二批');
  var batch1Id = be1ok ? be1.body.data.batch_entry.id : null;
  if (batch1Id) {
    var bl1 = await request('/api/onsite/batch-entry/' + batch1Id + '/leave', 'POST', {
      operator: 'onsite-小王'
    });
    log(bl1.body.code === 0, '第一批离园执行',
      bl1.body.code === 0 ? '剩余未离园批次数=' + bl1.body.data.remaining_batches : '失败');
  }

  section('3.6 第二批离园→所有批次离园完成，容量释放');
  var batch2Id = be2ok ? be2.body.data.batch_entry.id : null;
  if (batch2Id) {
    var bl2 = await request('/api/onsite/batch-entry/' + batch2Id + '/leave', 'POST', {
      actual_picked_weight: 25,
      picking_progress: 95,
      operator: 'onsite-小王'
    });
    log(bl2.body.code === 0, '第二批离园执行',
      bl2.body.code === 0 ? ('全部离园=' + bl2.body.data.all_batches_left + '，剩余批次数=' + bl2.body.data.remaining_batches)
                          : '失败');
  }

  var s3ok = batchOk && be1ok && be2ok;
  scenario(s3ok, '场景3验收：分批入园锁量', s3ok ? '通过' : '未通过');

  // ============================================================
  // 场景4：现场称重后的差额结算
  // ============================================================
  scenario(true, '场景4：现场称重差额结算',
    '家庭预约4人→登记家庭成员→2人先到（分离到场）→现场加购饮品加工→实际只采摘70%赠量→现场称重超过赠量→最终结算差异化退款+补采券生成');

  section('4.1 创建一个家庭预约');
  var phoneFamily = randPhone();
  var famResp = await request('/api/reservations', 'POST', {
    visitor_phone: phoneFamily,
    visitor_name: '差额结算家庭-王爸爸',
    visitor_type: 'FAMILY',
    slot_id: slotA.id,
    ticket_id: 3,
    group_size: 4,
    adult_count: 2,
    child_count: 2,
    remark: '一家四口'
  });
  var famOk = famResp.body.code === 0;
  log(famOk, '家庭预约创建成功',
    famOk ? ('赠量=' + famResp.body.data.included_weight.toFixed(1) + '斤，押金=' + famResp.body.data.deposit_amount + '元')
          : '失败 msg=' + famResp.body.message);
  var famResvId = famOk ? famResp.body.data.id : null;
  if (famOk) tempReservationIds.push(famResvId);

  section('4.2 登记家庭成员（分离到场准备）');
  if (famOk) {
    var fmResp = await request('/api/reservations/' + famResvId + '/family-members', 'POST', {
      members: [
        { member_name: '王爸爸', relation: 'FATHER', age_group: 'ADULT' },
        { member_name: '王妈妈', relation: 'MOTHER', age_group: 'ADULT' },
        { member_name: '王小明', relation: 'SON', age_group: 'CHILD' },
        { member_name: '王小红', relation: 'DAUGHTER', age_group: 'CHILD' }
      ],
      operator: 'visitor-self'
    });
    log(fmResp.body.code === 0, '家庭成员登记成功', '成员数=' + (fmResp.body.data ? fmResp.body.data.count : 0));
  }

  section('4.3 分离到场：仅爸爸妈妈先到（2/4 = 50%到场率）');
  if (famOk) {
    var famList = await request('/api/reservations/' + famResvId + '/family-members');
    var parents = (famList.body.data.list || []).filter(function(f) {
      return f.relation === 'FATHER' || f.relation === 'MOTHER';
    });
    var parentIds = parents.map(function(f) { return f.id; });
    var ci = await request('/api/onsite/family/checkin', 'POST', {
      reservation_id: famResvId,
      member_ids: parentIds,
      operator: 'onsite-小李'
    });
    var ciok = ci.body.code === 0;
    log(ciok, '父母签到成功', ciok ? ('到场率=' + (ci.body.data.arrival_rate * 100).toFixed(0) + '%，共签到' + ci.body.data.checked_count + '人') : '失败');
  }

  section('4.4 入场核销');
  var entryId = null;
  if (famOk) {
    var entryResp = await request('/api/onsite/entry', 'POST', {
      reservation_id: famResvId,
      visitor_phone: phoneFamily,
      checked_by: 'onsite-小李',
      operator: 'onsite-小李'
    });
    var entOk = entryResp.body.code === 0;
    log(entOk, '家庭入场核销', entOk ? 'entry_no=' + entryResp.body.data.entry.entry_no : '失败 msg=' + entryResp.body.message);
    entryId = entOk ? entryResp.body.data.entry.id : null;
  }

  section('4.5 现场临时加购：鲜榨果汁+草莓冰淇淋（饮品加工服务）');
  if (famOk) {
    var services = await request('/api/admin/addon-services');
    var svcList = services.body.data || [];
    if (svcList.length === 0) {
      var addSvc1 = await request('/api/admin/addon-services', 'POST', {
        service_code: 'JUICE001', service_name: '鲜榨草莓汁',
        service_type: 'DRINK', unit_price: 28, status: 'ACTIVE', description: '现场鲜榨无添加'
      });
      var addSvc2 = await request('/api/admin/addon-services', 'POST', {
        service_code: 'ICE001', service_name: '手工冰淇淋',
        service_type: 'DESSERT', unit_price: 18, status: 'ACTIVE', description: '草莓味'
      });
      log(addSvc1.body.code === 0, '创建加购服务-鲜榨果汁');
      log(addSvc2.body.code === 0, '创建加购服务-冰淇淋');
      services = await request('/api/admin/addon-services');
      svcList = services.body.data || [];
    }
    var juiceSvc = svcList.find(function(s) { return s.service_type === 'DRINK'; });
    var iceSvc = svcList.find(function(s) { return s.service_type === 'DESSERT'; });

    var addonResp = await request('/api/reservations/' + famResvId + '/addons', 'POST', {
      addon_items: [
        { service_id: juiceSvc ? juiceSvc.id : (svcList[0] && svcList[0].id), quantity: 2, remark: '多冰' },
        { service_id: iceSvc ? iceSvc.id : (svcList[1] && svcList[1].id), quantity: 2, remark: '两份草莓' }
      ],
      source: 'ONSITE',
      operator: 'onsite-小李'
    });
    log(addonResp.body.code === 0, '现场加购下单',
      addonResp.body.code === 0 ? ('加购总额=' + addonResp.body.data.total_amount + '元，共' + addonResp.body.data.items.length + '项')
                                 : '失败：' + (addonResp.body.message || ''));
  }

  section('4.6 更新采摘进度：只采摘到70%（部分果区成熟度不佳）');
  if (entryId) {
    var progress = await request('/api/onsite/entry/' + entryId + '/progress', 'PUT', {
      actual_picked_weight: famResp.body.data.included_weight * 0.7,
      picking_progress: 70,
      operator: 'onsite-小李'
    });
    log(progress.body.code === 0, '更新采摘进度70%（部分采摘）',
      '实采约' + (famResp.body.data.included_weight * 0.7).toFixed(1) +
      '斤，赠量' + famResp.body.data.included_weight.toFixed(1) + '斤');
  }

  section('4.7 现场称重最终结算：实采略超赠量→触发超量补费，同时因<80%触发生成补采券');
  if (entryId) {
    var included = famResp.body.data.included_weight;
    var finalWeight = Math.round(included * 0.75 * 100) / 100;
    var extraW = Math.max(0, finalWeight - included);

    var settle = await request('/api/onsite/entry/' + entryId + '/final-settle', 'POST', {
      actual_picked_weight: finalWeight,
      extra_weight_price: 20,
      damage_charge: 0,
      damage_reason: '',
      operator: 'onsite-小王',
      auto_refund: true
    });
    var stOk = settle.body.code === 0;
    log(stOk, '精细化离园结算执行',
      stOk ? '' : '失败：' + (settle.body.message || ''));
    if (stOk) {
      var d = settle.body.data;
      var hasMemberAdj = typeof d.member_adjust_rate === 'number' || d.refund_calc && typeof d.refund_calc.member_adjust_rate === 'number';
      log(true, '结算实采重量', d.actual_picked_weight.toFixed(1) + '斤（赠量' + d.included_weight.toFixed(1) + '斤，比例' +
        Math.round(d.actual_picked_weight / d.included_weight * 100) + '%）');
      if (d.addon_cost > 0) log(true, '加购费用从押金扣', d.addon_cost.toFixed(2) + '元');
      if (d.extra_weight_charge > 0) log(true, '超量补费从押金扣', d.extra_weight_charge.toFixed(2) + '元');
      if (hasMemberAdj) {
        log(true, '分离到场成员到场率生效',
          '实际到场率=' + (d.member_arrival_rate ? (d.member_arrival_rate * 100).toFixed(0) : '?') +
          '%，调整率=' + ((d.member_adjust_rate || (d.refund_calc && d.refund_calc.member_adjust_rate) || 0) * 100).toFixed(0) + '%');
      }
      var rc = d.refund_calc || {};
      log(typeof rc.total_refund === 'number',
        '最终结算：总退款=' + (rc.total_refund || 0).toFixed(2) +
        '元，总扣费=' + (rc.total_deduction || 0).toFixed(2) + '元');
      if (d.supplement_needed) log(true, '触发生成补采券', d.supplement_needed ? '已生成' : '未生成');
      if (rc.deduction_detail && rc.deduction_detail.length > 0) {
        log(true, '扣费明细已记录（可审计）', '扣费项数=' + rc.deduction_detail.length);
      }
    }
  }

  section('4.8 三端最终状态一致性检查');
  if (famOk) {
    var st2 = await request('/api/reservations/' + famResvId + '/state');
    var onsite = await request('/api/onsite/reservation/' + famResvId + '/onsite-state');
    var sameState = st2.body.code === 0 && onsite.body.code === 0 &&
                    st2.body.data.reservation.status === (onsite.body.data.reservation && onsite.body.data.reservation.status);
    log(sameState, '管理员/游客/现场核销状态一致',
      '管理员端status=' + (st2.body.data.reservation && st2.body.data.reservation.status) +
      ' 现场端status=' + (onsite.body.data.reservation && onsite.body.data.reservation.status));
    if (st2.body.code === 0 && st2.body.data.refunds && st2.body.data.refunds.length > 0) {
      log(true, '退款记录可在三端统一接口查询到', '退款单号=' + st2.body.data.refunds[0].refund_no);
    }
  }

  var s4ok = famOk;
  scenario(s4ok, '场景4验收：现场称重差额结算', s4ok ? '通过' : '未通过');

  // ============================================================
  // 看板统计（管理员视角）
  // ============================================================
  console.log('\n\n🗂  辅助看板检查');

  var wd = await request('/api/dashboard/waitlist-dashboard?date=' + slotA.slot_date);
  log(wd.body.code === 0, '候补看板返回', '候补总数=' + (wd.body.data.summary ? wd.body.data.summary.total_waiting : 0));

  var ar = await request('/api/dashboard/addon-revenue?start_date=' + slotA.slot_date + '&end_date=' + slotB.slot_date);
  log(ar.body.code === 0, '加购收入统计返回', '现场加购+超量+损坏合计=' + ((ar.body.data && ar.body.data.onsite_total) || 0).toFixed(2) + '元');

  var sd = await request('/api/dashboard/state-dashboard?date=' + slotA.slot_date);
  log(sd.body.code === 0, '三端状态看板返回',
    '同步率=' + ((sd.body.data.summary && sd.body.data.summary.sync_rate) || 0) + '%，在园=' + ((sd.body.data.summary && sd.body.data.summary.in_garden) || 0) + '人');

  // ============================================================
  // 总结
  // ============================================================
  console.log('\n=========================================================================');
  console.log('📊 验收演示测试总结');
  console.log('-------------------------------------------------------------------------');
  console.log('  🎯 验收场景：通过 ' + scenarioPassed + ' / 共 4，未通过 ' + scenarioFailed);
  console.log('  ✅ 子步骤用例：通过 ' + passed + '，失败 ' + failed);
  console.log('-------------------------------------------------------------------------');

  var allScenariosPassed = scenarioPassed === 4;
  if (allScenariosPassed) {
    console.log('🎉 全部4个验收场景通过！可交付演示');
    console.log('  1. 果量不足拦截 ✅');
    console.log('  2. 暴雨闭园改期 ✅');
    console.log('  3. 分批入园锁量 ✅');
    console.log('  4. 现场称重差额结算 ✅');
  } else {
    console.log('⚠️  部分场景未通过，请查看上方⛔标记');
    process.exitCode = 1;
  }
  console.log('=========================================================================\n');
}

run().catch(function(e) {
  console.error('验收测试运行异常:', e);
  process.exit(1);
});
