const store = require('./store');

const REFUND_RULES = {
  BEFORE_ENTRY: {
    DAYS_GT_3: { rate: 100, label: '入园前3天以上' },
    DAYS_1_3: { rate: 80, label: '入园前1-3天' },
    DAYS_LT_1: { rate: 50, label: '入园当天取消' }
  },
  AFTER_ENTRY: {
    PROGRESS_LT_30: { depositRate: 80, ticketRate: 50, label: '采摘进度<30%' },
    PROGRESS_30_70: { depositRate: 50, ticketRate: 20, label: '采摘进度30%-70%' },
    PROGRESS_GT_70: { depositRate: 10, ticketRate: 0, label: '采摘进度>70%' }
  },
  CLOSURE: { rate: 100, label: '闭园全额退款' }
};

function nowDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function nowDateTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  const diff = Math.abs(d2 - d1);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function isBlacklisted(visitorPhone, visitorIdcard) {
  const now = new Date();
  return store.findOne('visitor_blacklist', r =>
    r.status === 'BLOCKED' &&
    (r.visitor_phone === visitorPhone || (visitorIdcard && r.visitor_idcard === visitorIdcard)) &&
    (!r.expire_at || new Date(r.expire_at) > now)
  );
}

function isClosureDate(slotDate) {
  const alert = store.findOne('weather_alert', a =>
    a.alert_date === slotDate && a.is_closed === 1 && a.status === 'ACTIVE'
  );
  if (alert) return alert;
  const slot = store.findOne('time_slot', s => s.slot_date === slotDate && s.status === 'CLOSURE');
  if (slot) return { alert_type: '闭园', alert_level: '闭园', description: slot.limit_reason };
  return null;
}

function calcSlotAvailableWeight(slotId) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return 0;
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  let totalAvailable = 0;
  for (const zoneId of zoneIds) {
    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    );
    versions.forEach(v => {
      totalAvailable += (v.available_weight || 0) - (v.locked_weight || 0);
    });
  }
  return Math.max(0, totalAvailable);
}

function calcTicketWeight(ticketId, groupSize) {
  const ticket = store.getById('picking_ticket', ticketId);
  if (!ticket) return { estimated: 0, included: 0, extraLimit: 0 };
  return {
    estimated: (ticket.included_weight + ticket.max_extra_weight * 0.5) * groupSize,
    included: ticket.included_weight * groupSize,
    extraLimit: ticket.max_extra_weight * groupSize,
    ticket
  };
}

function tryLockWeight(slotId, weightToLock, reservationId) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  let remaining = weightToLock;
  const lockedDetails = [];
  const versionsToUpdate = [];
  for (const zoneId of zoneIds) {
    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    ).sort((a, b) => (b.maturity_level || 0) - (a.maturity_level || 0));
    for (const v of versions) {
      if (remaining <= 0) break;
      const available = Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0));
      const toLock = Math.min(available, remaining);
      if (toLock > 0) {
        lockedDetails.push({ versionId: v.id, zoneId: zoneId, batchCode: v.batch_code, locked: toLock });
        versionsToUpdate.push({ id: v.id, locked_weight: (v.locked_weight || 0) + toLock });
        remaining -= toLock;
      }
    }
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    return { success: false, message: `成熟果量不足，还差${remaining.toFixed(1)}斤` };
  }
  for (const u of versionsToUpdate) {
    store.update('maturity_version', u.id, { locked_weight: u.locked_weight });
  }
  return { success: true, lockedDetails, totalLocked: weightToLock };
}

function releaseLockedWeight(slotId, reservationId, actualPicked) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  let remainingToRelease = actualPicked;
  const releaseDetails = [];
  for (const zoneId of zoneIds) {
    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    ).sort((a, b) => (b.maturity_level || 0) - (a.maturity_level || 0));
    for (const v of versions) {
      if (remainingToRelease <= 0) break;
      const toRelease = Math.min(v.locked_weight || 0, remainingToRelease);
      if (toRelease > 0) {
        releaseDetails.push({ versionId: v.id, zoneId, batchCode: v.batch_code, released: toRelease });
        store.update('maturity_version', v.id, {
          locked_weight: (v.locked_weight || 0) - toRelease,
          picked_weight: (v.picked_weight || 0) + toRelease
        });
        remainingToRelease -= toRelease;
      }
    }
    if (remainingToRelease <= 0) break;
  }
  if (remainingToRelease > 0) {
    return { success: false, message: '释放锁量失败' };
  }
  return { success: true, releaseDetails };
}

function fullyReleaseLockedWeight(slotId, lockedDetails) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };
  if (!lockedDetails || lockedDetails.length === 0) return { success: true, count: 0 };
  let count = 0;
  for (const detail of lockedDetails) {
    const v = store.getById('maturity_version', detail.versionId);
    if (v) {
      store.update('maturity_version', v.id, {
        locked_weight: Math.max(0, (v.locked_weight || 0) - detail.locked)
      });
      count += detail.locked;
    }
  }
  return { success: true, count };
}

function tryCalcRefund(reservationId, reason, params = {}) {
  const reservation = store.getById('reservation', reservationId);
  if (!reservation) return { success: false, message: '预约不存在' };
  const entry = store.findOne('entry_record', e => e.reservation_id === reservationId);
  const ticketAmount = reservation.total_amount || 0;
  const depositAmount = reservation.deposit_amount || 0;
  const deductionDetail = [];
  let ticketRefund = 0;
  let depositRefund = 0;
  let refundRate = 0;
  let pickingProgress = 0;
  let refundReason = reason;

  if (reason === 'CLOSURE') {
    ticketRefund = ticketAmount;
    depositRefund = depositAmount;
    refundRate = 100;
    refundReason = '闭园全额退款';
    deductionDetail.push({ type: '闭园退款', amount: ticketAmount + depositAmount, reason: '天气原因闭园' });
  } else if (!entry || entry.entry_status === 'CANCELLED') {
    const slot = store.getById('time_slot', reservation.slot_id);
    const slotDate = slot?.slot_date || nowDate();
    const days = daysBetween(nowDate(), slotDate);
    let rule;
    if (days > 3) rule = REFUND_RULES.BEFORE_ENTRY.DAYS_GT_3;
    else if (days >= 1) rule = REFUND_RULES.BEFORE_ENTRY.DAYS_1_3;
    else rule = REFUND_RULES.BEFORE_ENTRY.DAYS_LT_1;
    ticketRefund = Math.round(ticketAmount * rule.rate / 100 * 100) / 100;
    depositRefund = Math.round(depositAmount * rule.rate / 100 * 100) / 100;
    refundRate = rule.rate;
    refundReason = refundReason || `预约取消(${rule.label})`;
    const ticketDeduct = ticketAmount - ticketRefund;
    const depositDeduct = depositAmount - depositRefund;
    if (ticketDeduct > 0) deductionDetail.push({ type: '票款扣费', amount: ticketDeduct, reason: rule.label });
    if (depositDeduct > 0) deductionDetail.push({ type: '押金扣费', amount: depositDeduct, reason: rule.label });
  } else {
    pickingProgress = entry.picking_progress || 0;
    let rule;
    if (pickingProgress < 30) rule = REFUND_RULES.AFTER_ENTRY.PROGRESS_LT_30;
    else if (pickingProgress <= 70) rule = REFUND_RULES.AFTER_ENTRY.PROGRESS_30_70;
    else rule = REFUND_RULES.AFTER_ENTRY.PROGRESS_GT_70;
    ticketRefund = Math.round(ticketAmount * rule.ticketRate / 100 * 100) / 100;
    depositRefund = Math.round(depositAmount * rule.depositRate / 100 * 100) / 100;
    refundRate = Math.round(((ticketRefund + depositRefund) / (ticketAmount + depositAmount) * 100) * 100) / 100;
    refundReason = refundReason || `中途离场(${rule.label})`;
    const ticketDeduct = ticketAmount - ticketRefund;
    const depositDeduct = depositAmount - depositRefund;
    if (ticketDeduct > 0) deductionDetail.push({ type: '票款扣费', amount: ticketDeduct, reason: rule.label });
    if (depositDeduct > 0) deductionDetail.push({ type: '押金扣费', amount: depositDeduct, reason: rule.label });
    if (params.extraWeightCharge && params.extraWeightCharge > 0) {
      depositRefund = Math.max(0, depositRefund - params.extraWeightCharge);
      deductionDetail.push({ type: '超量补费', amount: params.extraWeightCharge, reason: '采摘超出票面重量' });
    }
    if (params.damageCharge && params.damageCharge > 0) {
      depositRefund = Math.max(0, depositRefund - params.damageCharge);
      deductionDetail.push({ type: '损坏赔偿', amount: params.damageCharge, reason: params.damageReason || '果树/设施损坏' });
    }
  }

  return {
    success: true,
    reservation_no: reservation.reservation_no,
    visitor_phone: reservation.visitor_phone,
    visitor_name: reservation.visitor_name,
    original_ticket_amount: ticketAmount,
    original_deposit_amount: depositAmount,
    ticket_refund: ticketRefund,
    deposit_refund: depositRefund,
    total_refund: Math.round((ticketRefund + depositRefund) * 100) / 100,
    total_deduction: Math.round(((ticketAmount + depositAmount) - (ticketRefund + depositRefund)) * 100) / 100,
    refund_reason: refundReason,
    refund_rate: refundRate,
    picking_progress: pickingProgress,
    deduction_detail: deductionDetail
  };
}

module.exports = {
  REFUND_RULES,
  nowDate,
  nowDateTime,
  daysBetween,
  isBlacklisted,
  isClosureDate,
  calcSlotAvailableWeight,
  calcTicketWeight,
  tryLockWeight,
  releaseLockedWeight,
  fullyReleaseLockedWeight,
  tryCalcRefund
};
