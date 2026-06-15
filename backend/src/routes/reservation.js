const express = require('express');
const router = express.Router();
const store = require('../store');
const {
  nowDateTime, isBlacklisted, isClosureDate,
  calcSlotAvailableWeight, calcTicketWeight, tryLockWeight,
  fullyReleaseLockedWeight, tryCalcRefund, calcSlotDetailAvailability,
  syncStateToAll, processWaitlistPromotion
} = require('../utils');

function genNo(prefix) {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${ts}-${rand}`;
}

// 预约查询(列表)
router.get('/', (req, res) => {
  const { visitor_phone, status, slot_id } = req.query;
  let list = store.getAll('reservation');
  if (visitor_phone) list = list.filter(r => r.visitor_phone === visitor_phone);
  if (status) list = list.filter(r => r.status === status);
  if (slot_id) list = list.filter(r => r.slot_id === Number(slot_id));
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  const tickets = store.getAll('picking_ticket');
  const slots = store.getAll('time_slot');
  const ticketMap = new Map(tickets.map(t => [t.id, t]));
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const data = list.map(r => ({
    ...r,
    ticket: ticketMap.get(r.ticket_id) || null,
    slot: slotMap.get(r.slot_id) || null
  }));
  res.json({ code: 0, data });
});

// 根据预约号查询
router.get('/no/:reservation_no', (req, res) => {
  const r = store.findOne('reservation', x => x.reservation_no === req.params.reservation_no);
  if (!r) return res.json({ code: 404, message: '预约不存在' });
  const ticket = store.getById('picking_ticket', r.ticket_id);
  const slot = store.getById('time_slot', r.slot_id);
  res.json({ code: 0, data: { ...r, ticket, slot } });
});

// 创建预约
router.post('/', (req, res) => {
  const {
    visitor_phone, visitor_name, visitor_type, visitor_idcard,
    slot_id, ticket_id, group_size, adult_count, child_count,
    remark, source
  } = req.body;

  if (!visitor_phone || !visitor_name || !slot_id || !ticket_id || !group_size) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }

  const slot = store.getById('time_slot', Number(slot_id));
  if (!slot) return res.json({ code: 404, message: '时段不存在' });

  if (slot.status === 'CLOSURE') {
    return res.json({ code: 4102, message: `该时段已闭园：${slot.limit_reason || '闭园'}` });
  }

  const closure = isClosureDate(slot.slot_date);
  if (closure) {
    return res.json({ code: 4102, message: `${closure.alert_date} ${closure.alert_type}${closure.alert_level}，当日闭园，无法预约` });
  }

  const black = isBlacklisted(visitor_phone, visitor_idcard);
  if (black) {
    return res.json({ code: 4101, message: `您已被列入黑名单：${black.reason}` });
  }

  const ticket = store.getById('picking_ticket', Number(ticket_id));
  if (!ticket) return res.json({ code: 404, message: '采摘券不存在' });

  if (ticket.status !== 'ACTIVE') {
    return res.json({ code: 400, message: '采摘券已下架' });
  }

  const gs = Number(group_size) || 1;
  const ac = Number(adult_count) || (visitor_type === 'CHILD' ? 0 : gs);
  const cc = Number(child_count) || 0;

  if (slot.max_capacity - (slot.reserved_count || 0) < gs) {
    return res.json({ code: 4103, message: `时段容量不足，剩余${slot.max_capacity - (slot.reserved_count || 0)}人` });
  }

  if (slot.is_limited === 1) {
    return res.json({ code: 4104, message: `该时段已限流：${slot.limit_reason || '限流'}` });
  }

  const weightInfo = calcTicketWeight(Number(ticket_id), gs);
  const availableWeight = calcSlotAvailableWeight(Number(slot_id));

  if (availableWeight < weightInfo.estimated) {
    return res.json({ code: 4105, message: `成熟果量不足。需要约${weightInfo.estimated.toFixed(1)}斤，当前可用${availableWeight.toFixed(1)}斤` });
  }

  const reservation_no = genNo('RE');
  const total_amount = Math.round(ticket.price * gs * 100) / 100;
  const deposit_amount = Math.round(ticket.deposit * gs * 100) / 100;
  const payable_total = Math.round((total_amount + deposit_amount) * 100) / 100;

  const lockResult = tryLockWeight(Number(slot_id), weightInfo.estimated, null);
  if (!lockResult.success) {
    return res.json({ code: 4105, message: lockResult.message });
  }

  const reservation = store.insert('reservation', {
    reservation_no,
    visitor_phone, visitor_name,
    visitor_type: visitor_type || (ticket.ticket_type === 'CHILD' ? 'CHILD' : 'ADULT'),
    visitor_idcard: visitor_idcard || null,
    slot_id: Number(slot_id),
    ticket_id: Number(ticket_id),
    group_size: gs,
    adult_count: ac,
    child_count: cc,
    estimated_weight: weightInfo.estimated,
    included_weight: weightInfo.included,
    extra_weight_limit: weightInfo.extraLimit,
    total_amount,
    deposit_amount,
    payable_total,
    payment_status: 'PAID',
    status: 'CONFIRMED',
    locked_weight: weightInfo.estimated,
    lock_details: JSON.stringify(lockResult.lockedDetails),
    remark: remark || '',
    source: source || 'WEB'
  });

  store.update('time_slot', slot.id, { reserved_count: (slot.reserved_count || 0) + gs });

  store.insert('deposit_record', {
    deposit_no: genNo('DP'),
    reservation_id: reservation.id,
    visitor_phone,
    original_amount: deposit_amount,
    paid_amount: deposit_amount,
    paid_at: nowDateTime(),
    remaining_amount: deposit_amount,
    status: 'HELD'
  });

  res.json({ code: 0, data: { ...reservation, lock_details_parsed: lockResult.lockedDetails } });
});

// 退款试算(取消前预览)
router.post('/:id/refund-preview', (req, res) => {
  const id = Number(req.params.id);
  const { reason, extraWeightCharge, damageCharge, damageReason } = req.body;
  const result = tryCalcRefund(id, reason || 'USER_CANCEL', {
    extraWeightCharge: Number(extraWeightCharge) || 0,
    damageCharge: Number(damageCharge) || 0,
    damageReason: damageReason || ''
  });
  res.json({ code: result.success ? 0 : 400, message: result.message, data: result });
});

// 取消预约
router.post('/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const { cancel_reason, operator } = req.body;
  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `当前状态${reservation.status}不允许取消` });
  }

  const refundCalc = tryCalcRefund(id, cancel_reason || 'USER_CANCEL');
  if (!refundCalc.success) return res.json({ code: 400, message: refundCalc.message });

  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const slot = store.getById('time_slot', reservation.slot_id);

  if (reservation.lock_details) {
    try {
      const lockDetails = JSON.parse(reservation.lock_details);
      fullyReleaseLockedWeight(reservation.slot_id, lockDetails);
    } catch (e) {}
  }
  if (slot) {
    store.update('time_slot', slot.id, {
      reserved_count: Math.max(0, (slot.reserved_count || 0) - reservation.group_size)
    });
  }

  const updated = store.update('reservation', id, {
    status: 'CANCELLED',
    cancel_reason: cancel_reason || '用户取消',
    cancelled_at: nowDateTime(),
    refund_amount: refundCalc.total_refund
  });

  store.updateWhere('deposit_record', d => d.reservation_id === id && d.status === 'HELD', {
    status: refundCalc.deposit_refund > 0 ? 'REFUNDED' : 'DEDUCTED',
    remaining_amount: Math.max(0, (deposit => deposit - refundCalc.total_deduction)(reservation.deposit_amount)),
    refunded_amount: refundCalc.deposit_refund
  });

  const refund = store.insert('refund_record', {
    refund_no: genNo('RF'),
    reservation_id: id,
    visitor_phone: reservation.visitor_phone,
    original_ticket_amount: refundCalc.original_ticket_amount,
    original_deposit_amount: refundCalc.original_deposit_amount,
    ticket_refund: refundCalc.ticket_refund,
    deposit_refund: refundCalc.deposit_refund,
    total_refund: refundCalc.total_refund,
    total_deduction: refundCalc.total_deduction,
    refund_reason: refundCalc.refund_reason,
    refund_rate: refundCalc.refund_rate,
    picking_progress: refundCalc.picking_progress,
    deduction_detail: JSON.stringify(refundCalc.deduction_detail),
    refund_status: 'PROCESSED',
    processed_at: nowDateTime(),
    operator: operator || 'system'
  });

  res.json({ code: 0, data: { reservation: updated, refund } });
});

// 闭园批量处理(处理闭园日已有的预约)
router.post('/closure-process', (req, res) => {
  const { slot_date, alert_id, operator } = req.body;
  if (!slot_date) return res.json({ code: 400, message: '日期必填' });

  const slots = store.find('time_slot', s => s.slot_date === slot_date);
  const slotIds = slots.map(s => s.id);
  const reservations = store.find('reservation', r => slotIds.includes(r.slot_id) && r.status === 'CONFIRMED');

  const processed = [];
  for (const r of reservations) {
    const refundCalc = tryCalcRefund(r.id, 'CLOSURE');
    if (!refundCalc.success) continue;

    if (r.lock_details) {
      try { fullyReleaseLockedWeight(r.slot_id, JSON.parse(r.lock_details)); } catch (e) {}
    }
    const slot = store.getById('time_slot', r.slot_id);
    if (slot) {
      store.update('time_slot', slot.id, {
        reserved_count: Math.max(0, (slot.reserved_count || 0) - r.group_size)
      });
    }

    store.update('reservation', r.id, {
      status: 'CANCELLED',
      cancel_reason: `闭园取消：${slots[0]?.limit_reason || '暴雨'}`,
      cancelled_at: nowDateTime(),
      refund_amount: refundCalc.total_refund
    });

    store.updateWhere('deposit_record', d => d.reservation_id === r.id && d.status === 'HELD', {
      status: 'REFUNDED',
      remaining_amount: 0,
      refunded_amount: refundCalc.deposit_refund
    });

    store.insert('refund_record', {
      refund_no: `RF-CL-${r.reservation_no}`,
      reservation_id: r.id,
      visitor_phone: r.visitor_phone,
      original_ticket_amount: refundCalc.original_ticket_amount,
      original_deposit_amount: refundCalc.original_deposit_amount,
      ticket_refund: refundCalc.ticket_refund,
      deposit_refund: refundCalc.deposit_refund,
      total_refund: refundCalc.total_refund,
      total_deduction: refundCalc.total_deduction,
      refund_reason: refundCalc.refund_reason,
      refund_rate: refundCalc.refund_rate,
      picking_progress: 0,
      deduction_detail: JSON.stringify(refundCalc.deduction_detail),
      refund_status: 'PROCESSED',
      processed_at: nowDateTime(),
      operator: operator || 'system'
    });

    store.insert('closure_record', {
      closure_no: genNo('CR'),
      alert_id: alert_id || null,
      reservation_id: r.id,
      visitor_phone: r.visitor_phone,
      original_ticket: refundCalc.original_ticket_amount,
      original_deposit: refundCalc.original_deposit_amount,
      refund_amount: refundCalc.total_refund,
      refund_status: 'PROCESSED',
      operator: operator || 'system',
      executed_at: nowDateTime()
    });

    processed.push(r.id);
  }

  res.json({ code: 0, data: { count: processed.length, reservation_ids: processed, slot_date } });
});

// 时段细化状态查询(含满员原因说明)
router.get('/slot-availability/:slotId', (req, res) => {
  const slotId = Number(req.params.slotId);
  const slot = store.getById('time_slot', slotId);
  if (!slot) return res.json({ code: 404, message: '时段不存在' });
  const detail = calcSlotDetailAvailability(slotId);
  res.json({ code: 0, data: { slot, ...detail } });
});

// 候补预约登记
router.post('/waitlist', (req, res) => {
  const {
    visitor_phone, visitor_name, visitor_idcard,
    slot_id, ticket_id, group_size, adult_count, child_count,
    remark, source
  } = req.body;

  if (!visitor_phone || !visitor_name || !slot_id || !ticket_id || !group_size) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }

  const slot = store.getById('time_slot', Number(slot_id));
  if (!slot) return res.json({ code: 404, message: '时段不存在' });
  if (slot.status === 'CLOSURE') {
    return res.json({ code: 4102, message: '该时段已闭园，无法候补' });
  }

  const detail = calcSlotDetailAvailability(Number(slot_id));
  if (detail.can_book) {
    return res.json({ code: 400, message: '该时段仍有名额，请直接预约' });
  }

  const ticket = store.getById('picking_ticket', Number(ticket_id));
  if (!ticket) return res.json({ code: 404, message: '采摘券不存在' });

  const black = isBlacklisted(visitor_phone, visitor_idcard);
  if (black) {
    return res.json({ code: 4101, message: `您已被列入黑名单：${black.reason}` });
  }

  const gs = Number(group_size) || 1;
  const weightInfo = calcTicketWeight(Number(ticket_id), gs);
  const slotWaitlist = store.find('waitlist', w =>
    w.slot_id === Number(slot_id) && w.status === 'WAITING'
  );
  const queuePosition = slotWaitlist.length + 1;

  const waitlist = store.insert('waitlist', {
    waitlist_no: genNo('WL'),
    visitor_phone, visitor_name,
    visitor_idcard: visitor_idcard || null,
    slot_id: Number(slot_id),
    ticket_id: Number(ticket_id),
    group_size: gs,
    adult_count: Number(adult_count) || (gs),
    child_count: Number(child_count) || 0,
    estimated_weight: weightInfo.estimated,
    included_weight: weightInfo.included,
    queue_position: queuePosition,
    status: 'WAITING',
    expire_at: null,
    source: source || 'WEB',
    remark: remark || '',
    created_at: nowDateTime()
  });

  res.json({ code: 0, data: {
    ...waitlist,
    slot_info: { slot_date: slot.slot_date, slot_label: slot.slot_label },
    queue_position: queuePosition,
    ahead_count: queuePosition - 1,
    estimated_required_capacity: gs,
    estimated_required_weight: weightInfo.estimated,
    availability_reasons: detail.availability_reasons,
    zones: detail.zones
  }});
});

// 候补状态查询
router.get('/waitlist', (req, res) => {
  const { visitor_phone, slot_id, status } = req.query;
  let list = store.getAll('waitlist');
  if (visitor_phone) list = list.filter(w => w.visitor_phone === visitor_phone);
  if (slot_id) list = list.filter(w => w.slot_id === Number(slot_id));
  if (status) list = list.filter(w => w.status === status);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  const data = list.map(w => ({
    ...w,
    slot: store.getById('time_slot', w.slot_id),
    ticket: store.getById('picking_ticket', w.ticket_id)
  }));
  res.json({ code: 0, data });
});

// 候补取消
router.post('/waitlist/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const wl = store.getById('waitlist', id);
  if (!wl) return res.json({ code: 404, message: '候补记录不存在' });
  if (wl.status !== 'WAITING' && wl.status !== 'PROMOTED') {
    return res.json({ code: 400, message: '当前状态不允许取消' });
  }
  const updated = store.update('waitlist', id, {
    status: 'CANCELLED',
    cancelled_at: nowDateTime()
  });
  res.json({ code: 0, data: updated });
});

// 改期(平移预约到新时段)
router.post('/:id/reschedule', (req, res) => {
  const id = Number(req.params.id);
  const { new_slot_id, operator, reason } = req.body;
  if (!new_slot_id) return res.json({ code: 400, message: '新时段ID必填' });

  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `当前状态${reservation.status}不允许改期` });
  }

  const entry = store.findOne('entry_record', e =>
    e.reservation_id === id && e.entry_status === 'IN_GARDEN'
  );
  if (entry) {
    return res.json({ code: 400, message: '已入园无法改期' });
  }

  const oldSlot = store.getById('time_slot', reservation.slot_id);
  const newSlot = store.getById('time_slot', Number(new_slot_id));
  if (!newSlot) return res.json({ code: 404, message: '新时段不存在' });
  if (newSlot.status === 'CLOSURE') {
    return res.json({ code: 4102, message: '目标时段已闭园' });
  }

  const closure = isClosureDate(newSlot.slot_date);
  if (closure) {
    return res.json({ code: 4102, message: `${closure.alert_date} 已闭园` });
  }

  if (newSlot.max_capacity - (newSlot.reserved_count || 0) < reservation.group_size) {
    return res.json({ code: 4103, message: '目标时段容量不足' });
  }

  const weightInfo = calcTicketWeight(reservation.ticket_id, reservation.group_size);
  const availableWeight = calcSlotAvailableWeight(Number(new_slot_id));
  if (availableWeight < weightInfo.estimated) {
    return res.json({ code: 4105, message: `目标时段成熟果量不足，需要${weightInfo.estimated.toFixed(1)}斤，当前可用${availableWeight.toFixed(1)}斤` });
  }

  let oldLockDetails = [];
  if (reservation.lock_details) {
    try {
      oldLockDetails = JSON.parse(reservation.lock_details);
      fullyReleaseLockedWeight(reservation.slot_id, oldLockDetails);
    } catch (e) {}
  }

  if (oldSlot) {
    store.update('time_slot', oldSlot.id, {
      reserved_count: Math.max(0, (oldSlot.reserved_count || 0) - reservation.group_size)
    });
  }

  const lockResult = tryLockWeight(Number(new_slot_id), weightInfo.estimated, id);
  if (!lockResult.success) {
    if (oldLockDetails.length > 0) {
      tryLockWeight(reservation.slot_id, reservation.locked_weight || weightInfo.estimated, id);
    }
    if (oldSlot) {
      store.update('time_slot', oldSlot.id, {
        reserved_count: (oldSlot.reserved_count || 0) + reservation.group_size
      });
    }
    return res.json({ code: 4105, message: lockResult.message });
  }

  const reschedule_no = genNo('RS');
  store.insert('reschedule_record', {
    reschedule_no,
    reservation_id: id,
    old_slot_id: reservation.slot_id,
    new_slot_id: Number(new_slot_id),
    old_slot_date: oldSlot?.slot_date,
    new_slot_date: newSlot.slot_date,
    old_slot_label: oldSlot?.slot_label,
    new_slot_label: newSlot.slot_label,
    reason: reason || '',
    operator: operator || 'visitor',
    executed_at: nowDateTime()
  });

  const updated = store.update('reservation', id, {
    slot_id: Number(new_slot_id),
    lock_details: JSON.stringify(lockResult.lockedDetails),
    locked_weight: weightInfo.estimated,
    estimated_weight: weightInfo.estimated,
    included_weight: weightInfo.included,
    extra_weight_limit: weightInfo.extraLimit,
    last_reschedule_no: reschedule_no,
    reschedule_count: (reservation.reschedule_count || 0) + 1
  });

  store.update('time_slot', Number(new_slot_id), {
    reserved_count: (newSlot.reserved_count || 0) + reservation.group_size
  });

  try {
    processWaitlistPromotion(reservation.slot_id, 3);
  } catch (e) {}

  syncStateToAll(id, 'RESCHEDULE', operator || 'visitor');

  res.json({ code: 0, data: {
    reservation: updated,
    reschedule_no,
    old_slot: oldSlot,
    new_slot: newSlot,
    lock_details_parsed: lockResult.lockedDetails
  }});
});

// 改期记录查询
router.get('/reschedule-records', (req, res) => {
  const { reservation_id } = req.query;
  let list = store.getAll('reschedule_record');
  if (reservation_id) list = list.filter(r => r.reservation_id === Number(reservation_id));
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

// 加购服务预订(提前预订或现场加购)
router.post('/:id/addons', (req, res) => {
  const id = Number(req.params.id);
  const { addon_items, operator, source } = req.body;
  if (!addon_items || !Array.isArray(addon_items) || addon_items.length === 0) {
    return res.json({ code: 400, message: '加购项必填' });
  }

  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  let totalAmount = 0;
  const items = [];
  for (const item of addon_items) {
    const svc = store.getById('addon_service', Number(item.service_id));
    if (!svc) return res.json({ code: 404, message: `加购服务ID=${item.service_id}不存在` });
    if (svc.status !== 'ACTIVE') {
      return res.json({ code: 400, message: `服务[${svc.service_name}]已下架` });
    }
    const qty = Number(item.quantity) || 1;
    const amount = Math.round(svc.unit_price * qty * 100) / 100;
    totalAmount += amount;
    items.push({
      service_id: svc.id,
      service_code: svc.service_code,
      service_name: svc.service_name,
      service_type: svc.service_type,
      unit_price: svc.unit_price,
      quantity: qty,
      sub_total: amount,
      remark: item.remark || ''
    });
  }

  const addonOrder = store.insert('addon_order', {
    addon_order_no: genNo('AO'),
    reservation_id: id,
    visitor_phone: reservation.visitor_phone,
    items: JSON.stringify(items),
    total_amount: totalAmount,
    paid_amount: 0,
    payment_status: 'UNPAID',
    source: source || 'ONSITE',
    operator: operator || 'visitor',
    created_at: nowDateTime()
  });

  const existing = store.findOne('on_site_extra', o => o.reservation_id === id);
  const addon_cost = (existing?.addon_cost || 0) + totalAmount;
  if (existing) {
    store.update('on_site_extra', existing.id, {
      addon_cost,
      addon_order_ids: JSON.stringify(
        [...(JSON.parse(existing.addon_order_ids || '[]')), addonOrder.id]
      ),
      updated_at: nowDateTime()
    });
  } else {
    store.insert('on_site_extra', {
      reservation_id: id,
      visitor_phone: reservation.visitor_phone,
      addon_cost,
      extra_weight_charge: 0,
      damage_charge: 0,
      addon_order_ids: JSON.stringify([addonOrder.id]),
      created_at: nowDateTime(),
      updated_at: nowDateTime()
    });
  }

  syncStateToAll(id, 'ADDON_ADD', operator || 'visitor');

  res.json({ code: 0, data: {
    addon_order: addonOrder,
    items,
    total_amount: totalAmount
  }});
});

// 查询加购订单
router.get('/:id/addons', (req, res) => {
  const id = Number(req.params.id);
  const list = store.find('addon_order', a => a.reservation_id === id)
    .sort((a, b) => (b.id || 0) - (a.id || 0));
  const data = list.map(a => ({
    ...a,
    items_parsed: JSON.parse(a.items || '[]')
  }));
  const extra = store.findOne('on_site_extra', o => o.reservation_id === id);
  res.json({ code: 0, data: { list: data, on_site_extra: extra } });
});

// 家庭成员管理(分离到场签到准备)
router.post('/:id/family-members', (req, res) => {
  const id = Number(req.params.id);
  const { members, operator } = req.body;
  if (!members || !Array.isArray(members)) {
    return res.json({ code: 400, message: '成员列表必填' });
  }
  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  store.deleteWhere('family_member', f => f.reservation_id === id);

  const saved = [];
  for (const m of members) {
    saved.push(store.insert('family_member', {
      reservation_id: id,
      visitor_phone: reservation.visitor_phone,
      member_name: m.member_name,
      member_idcard: m.member_idcard || '',
      relation: m.relation || 'OTHER',
      age_group: m.age_group || (m.is_child ? 'CHILD' : 'ADULT'),
      checkin_status: 'PENDING',
      created_at: nowDateTime()
    }));
  }
  res.json({ code: 0, data: { count: saved.length, members: saved } });
});

// 查询家庭成员
router.get('/:id/family-members', (req, res) => {
  const id = Number(req.params.id);
  const list = store.find('family_member', f => f.reservation_id === id);
  const checkedIn = list.filter(f => f.checkin_status === 'CHECKED_IN').length;
  res.json({ code: 0, data: {
    list,
    total_count: list.length,
    checked_in_count: checkedIn,
    arrival_rate: list.length > 0 ? Math.round(checkedIn / list.length * 100) : 0
  }});
});

// 三端状态拉取(管理员/游客/现场核销统一入口)
router.get('/:id/state', (req, res) => {
  const id = Number(req.params.id);
  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const slot = store.getById('time_slot', reservation.slot_id);
  const entry = store.findOne('entry_record', e => e.reservation_id === id);
  const deposit = store.findOne('deposit_record', d => d.reservation_id === id);
  const refunds = store.find('refund_record', r => r.reservation_id === id);
  const waitlist = store.findOne('waitlist', w => w.original_reservation_id === id && w.status === 'WAITING');
  const family = store.find('family_member', f => f.reservation_id === id);
  const extra = store.findOne('on_site_extra', o => o.reservation_id === id);
  const addonOrders = store.find('addon_order', a => a.reservation_id === id);
  const syncLogs = store.find('state_sync_log', s => s.reservation_id === id)
    .sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 20);
  const rescheduleRecords = store.find('reschedule_record', r => r.reservation_id === id);

  const zoneIds = JSON.parse(slot?.zone_ids || '[]');
  const zones = zoneIds.map(zid => store.getById('orchard_zone', zid)).filter(Boolean);
  const checkedIn = family.filter(f => f.checkin_status === 'CHECKED_IN').length;

  res.json({ code: 0, data: {
    reservation: {
      id: reservation.id,
      reservation_no: reservation.reservation_no,
      status: reservation.status,
      visitor_name: reservation.visitor_name,
      visitor_phone: reservation.visitor_phone,
      group_size: reservation.group_size,
      adult_count: reservation.adult_count,
      child_count: reservation.child_count,
      total_amount: reservation.total_amount,
      deposit_amount: reservation.deposit_amount,
      payable_total: reservation.payable_total,
      payment_status: reservation.payment_status,
      refund_amount: reservation.refund_amount,
      estimated_weight: reservation.estimated_weight,
      included_weight: reservation.included_weight,
      extra_weight_limit: reservation.extra_weight_limit,
      cancel_reason: reservation.cancel_reason,
      last_reschedule_no: reservation.last_reschedule_no,
      reschedule_count: reservation.reschedule_count || 0,
      remark: reservation.remark,
      created_at: reservation.created_at,
      cancelled_at: reservation.cancelled_at,
      completed_at: reservation.completed_at
    },
    ticket,
    slot: slot ? {
      id: slot.id,
      slot_date: slot.slot_date,
      slot_start: slot.slot_start,
      slot_end: slot.slot_end,
      slot_label: slot.slot_label,
      status: slot.status,
      max_capacity: slot.max_capacity,
      reserved_count: slot.reserved_count,
      entered_count: slot.entered_count,
      is_limited: slot.is_limited,
      limit_reason: slot.limit_reason
    } : null,
    entry: entry ? {
      entry_no: entry.entry_no,
      entry_status: entry.entry_status,
      entry_time: entry.entry_time,
      leave_time: entry.leave_time,
      group_size: entry.group_size,
      actual_picked_weight: entry.actual_picked_weight,
      picking_progress: entry.picking_progress,
      included_weight: entry.included_weight,
      extra_weight_limit: entry.extra_weight_limit,
      checked_by: entry.checked_by
    } : null,
    deposit: deposit ? {
      original_amount: deposit.original_amount,
      paid_amount: deposit.paid_amount,
      remaining_amount: deposit.remaining_amount,
      status: deposit.status,
      refunded_amount: deposit.refunded_amount,
      deducted_amount: deposit.deducted_amount
    } : null,
    refunds: refunds.map(r => ({
      refund_no: r.refund_no,
      ticket_refund: r.ticket_refund,
      deposit_refund: r.deposit_refund,
      total_refund: r.total_refund,
      total_deduction: r.total_deduction,
      refund_reason: r.refund_reason,
      refund_rate: r.refund_rate,
      picking_progress: r.picking_progress,
      deduction_detail_parsed: JSON.parse(r.deduction_detail || '[]'),
      processed_at: r.processed_at
    })),
    waitlist: waitlist ? {
      waitlist_no: waitlist.waitlist_no,
      queue_position: waitlist.queue_position,
      status: waitlist.status,
      expire_at: waitlist.expire_at
    } : null,
    family: {
      list: family,
      total_count: family.length,
      checked_in_count: checkedIn,
      arrival_rate: family.length > 0 ? checkedIn / family.length : null
    },
    on_site_extra: extra ? {
      addon_cost: extra.addon_cost,
      extra_weight_charge: extra.extra_weight_charge,
      damage_charge: extra.damage_charge,
      total_extra: Math.round((extra.addon_cost + extra.extra_weight_charge + extra.damage_charge) * 100) / 100
    } : null,
    addon_orders: addonOrders.map(a => ({
      addon_order_no: a.addon_order_no,
      items_parsed: JSON.parse(a.items || '[]'),
      total_amount: a.total_amount,
      payment_status: a.payment_status,
      source: a.source,
      created_at: a.created_at
    })),
    zones: zones.map(z => ({
      zone_id: z.id,
      zone_code: z.zone_code,
      zone_name: z.zone_name,
      fruit_type: z.fruit_type,
      fruit_variety: z.fruit_variety,
      area_size: z.area_size
    })),
    reschedule_count: rescheduleRecords.length,
    state_sync_logs: syncLogs.map(s => ({
      source: s.source,
      state_snapshot: JSON.parse(s.state_snapshot || '{}'),
      operator: s.operator,
      synced_at: s.synced_at
    }))
  }});
});

// 预约详情（必须放在所有带固定路径的GET路由之后，否则会拦截/waitlist等路径）
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = store.getById('reservation', id);
  if (!r) return res.json({ code: 404, message: '预约不存在' });
  const ticket = store.getById('picking_ticket', r.ticket_id);
  const slot = store.getById('time_slot', r.slot_id);
  const entry = store.findOne('entry_record', e => e.reservation_id === id);
  const deposit = store.findOne('deposit_record', d => d.reservation_id === id);
  const refund = store.find('refund_record', rf => rf.reservation_id === id);
  const exception = store.find('exception_record', e => e.reservation_id === id);
  res.json({ code: 0, data: { ...r, ticket, slot, entry, deposit, refunds: refund, exceptions: exception } });
});

module.exports = router;
