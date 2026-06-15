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
  PARTIAL_PICK: {
    PICKED_LT_50_INCLUDED: { depositRate: 90, ticketRate: 70, label: '实采<含赠50%', extraTip: '可申请补采券' },
    PICKED_50_80_INCLUDED: { depositRate: 80, ticketRate: 50, label: '实采50%-80%含赠', extraTip: '可申请补采券' },
    PICKED_80_100_INCLUDED: { depositRate: 60, ticketRate: 30, label: '实采80%-100%含赠' },
    PICKED_GT_INCLUDED: { depositRate: 40, ticketRate: 10, label: '实采超过含赠' }
  },
  CLOSURE: { rate: 100, label: '闭园全额退款' },
  RESCHEDULE: { rate: 100, label: '改期全额平移' }
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

function getActiveZonesBySlot(slotId) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return [];
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  const activeZones = zoneIds.map(zid => {
    const zone = store.getById('orchard_zone', zid);
    if (!zone || zone.status !== 'ACTIVE') return null;
    const zoneClosure = store.findOne('closure_record', c =>
      c.zone_id === zid && c.closure_date === slot.slot_date && c.status === 'ACTIVE'
    );
    if (zoneClosure) {
      return { ...zone, _closure: zoneClosure };
    }
    return zone;
  }).filter(Boolean);
  return activeZones;
}

function calcSlotAvailableWeight(slotId, opts = {}) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return 0;
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  let totalAvailable = 0;
  for (const zoneId of zoneIds) {
    const zone = store.getById('orchard_zone', zoneId);
    if (!zone || zone.status !== 'ACTIVE') continue;
    const zoneClosure = store.findOne('closure_record', c =>
      c.zone_id === zoneId && c.closure_date === slot.slot_date && c.status === 'ACTIVE'
    );
    if (zoneClosure && !opts.includeClosedZones) continue;
    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    );
    versions.forEach(v => {
      totalAvailable += Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0));
    });
  }
  return Math.max(0, totalAvailable);
}

function calcSlotDetailAvailability(slotId) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return null;
  const zoneIds = JSON.parse(slot.zone_ids || '[]');

  const capacityTotal = slot.max_capacity || 0;
  const capacityUsed = slot.reserved_count || 0;
  const capacityRemaining = Math.max(0, capacityTotal - capacityUsed);

  const batchUsed = store.find('batch_entry', b =>
    b.slot_id === slotId && b.status === 'ACTIVE'
  ).reduce((s, b) => s + (b.allocated_size || 0), 0);
  const batchReserved = store.find('reservation', r =>
    r.slot_id === slotId && r.status === 'CONFIRMED' && r.batch_entry_id
  ).length;
  const waitlistCount = store.find('waitlist', w =>
    w.slot_id === slotId && w.status === 'WAITING'
  ).length;

  const unreleasedSupplement = store.find('reservation', r =>
    r.slot_id === slotId && r.status === 'CONFIRMED' && r.supplement_locked_weight > 0
  ).reduce((s, r) => s + (r.supplement_locked_weight || 0), 0);

  const activeZones = [];
  const closedZones = [];
  const lowMaturityZones = [];

  for (const zoneId of zoneIds) {
    const zone = store.getById('orchard_zone', zoneId);
    if (!zone) continue;
    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    );
    const avgMaturity = versions.length > 0
      ? versions.reduce((s, v) => s + (v.maturity_level || 0), 0) / versions.length
      : 0;
    const zoneAvailable = versions.reduce((s, v) =>
      s + Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0)), 0);

    const zoneClosure = store.findOne('closure_record', c =>
      c.zone_id === zoneId && c.closure_date === slot.slot_date && c.status === 'ACTIVE'
    );

    const zoneInfo = {
      zone_id: zoneId,
      zone_name: zone.zone_name,
      fruit_type: zone.fruit_type,
      avg_maturity: avgMaturity,
      available_weight: zoneAvailable,
      versions: versions.map(v => ({
        id: v.id,
        batch_code: v.batch_code,
        maturity_level: v.maturity_level,
        available: Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0)),
        locked: v.locked_weight || 0
      }))
    };

    if (zoneClosure) {
      closedZones.push({ ...zoneInfo, closure_reason: zoneClosure.reason });
    } else if (avgMaturity < 60) {
      lowMaturityZones.push(zoneInfo);
    } else {
      activeZones.push(zoneInfo);
    }
  }

  const totalActiveWeight = activeZones.reduce((s, z) => s + z.available_weight, 0);

  const reasons = [];
  if (slot.status === 'CLOSURE') {
    reasons.push({ type: 'FULL_CLOSURE', message: slot.limit_reason || '全园闭园' });
  }
  if (closedZones.length > 0) {
    reasons.push({ type: 'ZONE_CLOSURE', message: `${closedZones.length}个果区关闭: ${closedZones.map(z => z.zone_name).join(',')}` });
  }
  if (lowMaturityZones.length > 0) {
    reasons.push({ type: 'LOW_MATURITY', message: `${lowMaturityZones.length}个果区成熟度不足(<60%): ${lowMaturityZones.map(z => z.zone_name).join(',')}` });
  }
  if (batchUsed > 0) {
    reasons.push({ type: 'GROUP_BATCH', message: `团体预占${batchUsed}人(${batchReserved}笔分批入园)` });
  }
  if (waitlistCount > 0) {
    reasons.push({ type: 'WAITLIST', message: `${waitlistCount}人在候补队列中` });
  }
  if (unreleasedSupplement > 0) {
    reasons.push({ type: 'SUPPLEMENT_LOCK', message: `补采券未释放锁量${unreleasedSupplement.toFixed(1)}斤` });
  }
  if (capacityRemaining <= 0 && totalActiveWeight <= 0) {
    reasons.push({ type: 'CAPACITY_AND_WEIGHT', message: '时段容量和可用果量均已满' });
  } else if (capacityRemaining <= 0) {
    reasons.push({ type: 'CAPACITY_FULL', message: '时段容量已满，但果量可能仍有剩余（可联系现场调剂）' });
  } else if (totalActiveWeight <= 0) {
    reasons.push({ type: 'WEIGHT_LOCKED', message: '可用果量已被锁完，但容量可能仍有剩余（可联系现场调剂）' });
  }

  return {
    slot_id: slotId,
    slot,
    capacity: {
      total: capacityTotal,
      used: capacityUsed,
      remaining: capacityRemaining,
      batch_allocated: batchUsed,
      batch_confirmed: batchReserved
    },
    weight: {
      available: totalActiveWeight,
      supplement_locked: unreleasedSupplement,
      waitlist_count: waitlistCount
    },
    zones: {
      active: activeZones,
      low_maturity: lowMaturityZones,
      closed: closedZones
    },
    availability_reasons: reasons,
    is_available: slot.status === 'AVAILABLE' && slot.is_limited !== 1 && capacityRemaining > 0 && totalActiveWeight > 0,
    can_waitlist: slot.status === 'AVAILABLE' && slot.is_limited !== 1 && waitlistCount < 20
  };
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

function tryLockWeight(slotId, weightToLock, reservationId, opts = {}) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };
  const zoneIds = JSON.parse(slot.zone_ids || '[]');
  let remaining = weightToLock;
  const lockedDetails = [];
  const versionsToUpdate = [];
  for (const zoneId of zoneIds) {
    const zoneClosure = store.findOne('closure_record', c =>
      c.zone_id === zoneId && c.closure_date === slot.slot_date && c.status === 'ACTIVE'
    );
    if (zoneClosure && !opts.skipZoneCheck) continue;

    const versions = store.find('maturity_version', v =>
      v.zone_id === zoneId && v.status === 'ACTIVE' && v.version_date === slot.slot_date
    ).sort((a, b) => (b.maturity_level || 0) - (a.maturity_level || 0));

    for (const v of versions) {
      if (remaining <= 0) break;
      if ((v.maturity_level || 0) < 50 && !opts.includeImmature) continue;
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
  if (remaining > 0.01) {
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
        releaseDetails.push({ versionId: v.id, zoneId, batchCode: v.batch_code, released: toRelease, type: 'PICKED' });
        store.update('maturity_version', v.id, {
          locked_weight: Math.max(0, (v.locked_weight || 0) - toRelease),
          picked_weight: (v.picked_weight || 0) + toRelease
        });
        remainingToRelease -= toRelease;
      }
    }
    if (remainingToRelease <= 0) break;
  }
  return { success: true, releaseDetails, pickedReleased: actualPicked - remainingToRelease, unusedReleased: remainingToRelease };
}

function fullyReleaseLockedWeight(slotId, lockedDetails) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };
  if (!lockedDetails || lockedDetails.length === 0) return { success: true, count: 0 };
  let count = 0;
  for (const detail of lockedDetails) {
    const v = store.getById('maturity_version', detail.versionId);
    if (v) {
      const releaseAmt = Math.min(detail.locked, v.locked_weight || 0);
      store.update('maturity_version', v.id, {
        locked_weight: Math.max(0, (v.locked_weight || 0) - releaseAmt)
      });
      count += releaseAmt;
    }
  }
  return { success: true, count };
}

function recalcAfterMaturityChange(versionId, operator) {
  const version = store.getById('maturity_version', versionId);
  if (!version) return { success: false, message: '批次不存在' };

  store.insert('weight_adjust_log', {
    version_id: versionId,
    zone_id: version.zone_id,
    old_maturity: version.maturity_level,
    new_maturity: version.maturity_level,
    old_ripe: version.ripe_weight,
    new_ripe: version.ripe_weight,
    old_available: version.available_weight,
    new_available: version.available_weight,
    operator: operator || 'system',
    adjusted_at: nowDateTime()
  });

  const affectedReservations = store.find('reservation', r => {
    if (r.status !== 'CONFIRMED' && r.status !== 'IN_GARDEN') return false;
    try {
      const locks = JSON.parse(r.lock_details || '[]');
      return locks.some(l => l.versionId === versionId);
    } catch (e) {
      return false;
    }
  });

  const overLocked = [];
  for (const r of affectedReservations) {
    try {
      const locks = JSON.parse(r.lock_details || '[]');
      let totalLock = locks.reduce((s, l) => s + (l.locked || 0), 0);
      let needWeight = 0;
      for (const l of locks) {
        if (l.versionId === versionId) {
          const v = store.getById('maturity_version', l.versionId);
          if (v) {
            const avail = Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0));
            if (avail < 0) {
              needWeight += Math.abs(avail);
            }
          }
        }
      }
      if (needWeight > 0) {
        overLocked.push({
          reservation_id: r.id,
          reservation_no: r.reservation_no,
          locked_weight: r.locked_weight,
          shortfall: needWeight
        });
      }
    } catch (e) {}
  }

  const waitlistToPromote = store.find('waitlist', w => {
    if (w.status !== 'WAITING') return false;
    const slot = store.getById('time_slot', w.slot_id);
    if (!slot) return false;
    const zoneIds = JSON.parse(slot.zone_ids || '[]');
    return zoneIds.includes(version.zone_id);
  }).sort((a, b) => (a.position || 0) - (b.position || 0));

  const promoted = [];
  for (const w of waitlistToPromote.slice(0, 5)) {
    const avail = calcSlotAvailableWeight(w.slot_id);
    const weightInfo = calcTicketWeight(w.ticket_id, w.group_size || 1);
    if (avail >= weightInfo.estimated &&
        (store.getById('time_slot', w.slot_id)?.max_capacity || 0) -
        (store.getById('time_slot', w.slot_id)?.reserved_count || 0) >= (w.group_size || 1)) {
      promoted.push({
        waitlist_id: w.id,
        visitor_name: w.visitor_name,
        weight_needed: weightInfo.estimated,
        weight_available: avail
      });
    }
  }

  return {
    success: true,
    version_id: versionId,
    affected_reservation_count: affectedReservations.length,
    over_locked_count: overLocked.length,
    over_locked: overLocked.slice(0, 20),
    waitlist_promotable_count: promoted.length,
    promotable_waitlist: promoted,
    new_available_weight: Math.max(0, (version.available_weight || 0) - (version.locked_weight || 0))
  };
}

function processWaitlistPromotion(slotId, maxCount = 3) {
  const slot = store.getById('time_slot', slotId);
  if (!slot) return { success: false, message: '时段不存在' };

  const waiters = store.find('waitlist', w =>
    w.slot_id === slotId && w.status === 'WAITING'
  ).sort((a, b) => (a.position || 0) - (b.position || 0));

  const promoted = [];
  for (const w of waiters) {
    if (promoted.length >= maxCount) break;
    const weightInfo = calcTicketWeight(w.ticket_id, w.group_size || 1);
    const availWeight = calcSlotAvailableWeight(slotId);
    const availCapacity = Math.max(0, (slot.max_capacity || 0) - (slot.reserved_count || 0));

    if (availCapacity < (w.group_size || 1) || availWeight < weightInfo.estimated) continue;

    const lockResult = tryLockWeight(slotId, weightInfo.estimated, null);
    if (!lockResult.success) continue;

    store.update('waitlist', w.id, {
      status: 'PROMOTED',
      promoted_at: nowDateTime(),
      promoted_expire_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    });

    promoted.push({
      waitlist_id: w.id,
      visitor_phone: w.visitor_phone,
      visitor_name: w.visitor_name,
      group_size: w.group_size,
      weight_needed: weightInfo.estimated,
      expire_minutes: 30
    });
  }

  return {
    success: true,
    slot_id: slotId,
    promoted_count: promoted.length,
    promoted: promoted
  };
}

function tryCalcRefund(reservationId, reason, params = {}) {
  const reservation = store.getById('reservation', reservationId);
  if (!reservation) return { success: false, message: '预约不存在' };

  const entry = store.findOne('entry_record', e => e.reservation_id === reservationId);
  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const ticketAmount = reservation.total_amount || 0;
  const depositAmount = reservation.deposit_amount || 0;
  const deductionDetail = [];
  const addonCost = params.addonCost || 0;
  let ticketRefund = 0;
  let depositRefund = 0;
  let refundRate = 0;
  let pickingProgress = 0;
  let refundReason = reason;
  let supplementAvailable = 0;
  let supplementInfo = null;

  const members = store.find('family_member', m => m.reservation_id === reservationId);
  const arrivedCount = members.filter(m => m.arrived_at).length;
  const totalMembers = members.length || reservation.group_size || 1;
  const memberArrivalRate = arrivedCount / totalMembers;

  if (reason === 'CLOSURE') {
    ticketRefund = ticketAmount;
    depositRefund = depositAmount;
    refundRate = 100;
    refundReason = '闭园全额退款';
    deductionDetail.push({ type: '闭园退款', amount: ticketAmount + depositAmount, reason: '天气原因闭园' });
  } else if (reason === 'RESCHEDULE') {
    ticketRefund = 0;
    depositRefund = 0;
    refundRate = 0;
    refundReason = '改期全额平移至新时段';
    deductionDetail.push({ type: '改期平移', amount: 0, reason: params.rescheduleNote || '改期至新预约' });
  } else if (!entry || entry.entry_status === 'CANCELLED' || entry.entry_status === 'PENDING') {
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
    const actualPicked = params.actualPickedWeight != null ? params.actualPickedWeight : (entry.actual_picked_weight || 0);
    const includedWeight = reservation.included_weight || 0;
    const pickRate = includedWeight > 0 ? Math.min(100, actualPicked / includedWeight * 100) : 0;
    const extraWeightCharge = Number(params.extraWeightCharge) || 0;
    const damageCharge = Number(params.damageCharge) || 0;

    let rule;
    if (pickRate < 50) {
      rule = REFUND_RULES.PARTIAL_PICK.PICKED_LT_50_INCLUDED;
      supplementAvailable = Math.max(0, (includedWeight - actualPicked) * 0.8);
      supplementInfo = {
        type: 'SUPPLEMENT_VOUCHER',
        available_weight: supplementAvailable,
        valid_days: 30,
        reason: `实采${actualPicked.toFixed(1)}斤不足含赠${includedWeight}斤的50%`
      };
    } else if (pickRate < 80) {
      rule = REFUND_RULES.PARTIAL_PICK.PICKED_50_80_INCLUDED;
      supplementAvailable = Math.max(0, (includedWeight - actualPicked) * 0.5);
      supplementInfo = {
        type: 'SUPPLEMENT_VOUCHER',
        available_weight: supplementAvailable,
        valid_days: 15,
        reason: `实采${actualPicked.toFixed(1)}斤为含赠${includedWeight}斤的${Math.round(pickRate)}%`
      };
    } else if (pickRate <= 100) {
      rule = REFUND_RULES.PARTIAL_PICK.PICKED_80_100_INCLUDED;
    } else {
      rule = REFUND_RULES.PARTIAL_PICK.PICKED_GT_INCLUDED;
    }

    let memberAdjustRate = 1;
    if (members.length > 0 && arrivedCount < totalMembers) {
      memberAdjustRate = 0.5 + memberArrivalRate * 0.5;
      deductionDetail.push({
        type: '成员到场率调整',
        amount: 0,
        reason: `应到${totalMembers}人实到${arrivedCount}人，综合系数${memberAdjustRate.toFixed(2)}`
      });
    }

    ticketRefund = Math.round(ticketAmount * rule.ticketRate / 100 * memberAdjustRate * 100) / 100;
    depositRefund = Math.round(depositAmount * rule.depositRate / 100 * memberAdjustRate * 100) / 100;

    if (addonCost > 0) {
      depositRefund = Math.max(0, depositRefund - addonCost);
      deductionDetail.push({ type: '加购服务', amount: addonCost, reason: '饮品/加工/附加服务消费' });
    }

    if (extraWeightCharge > 0) {
      depositRefund = Math.max(0, depositRefund - extraWeightCharge);
      deductionDetail.push({
        type: '超量补费',
        amount: extraWeightCharge,
        reason: `采摘超出票面重量${(actualPicked - includedWeight).toFixed(1)}斤`
      });
    }
    if (damageCharge > 0) {
      depositRefund = Math.max(0, depositRefund - damageCharge);
      deductionDetail.push({ type: '损坏赔偿', amount: damageCharge, reason: params.damageReason || '果树/设施损坏' });
    }

    const ticketDeduct = ticketAmount - ticketRefund;
    const depositDeduct = depositAmount - depositRefund - addonCost - extraWeightCharge - damageCharge;
    if (ticketDeduct > 0) deductionDetail.push({ type: '票款扣费', amount: ticketDeduct, reason: rule.label });
    if (depositDeduct > 0) deductionDetail.push({ type: '押金扣费', amount: Math.max(0, depositDeduct), reason: rule.label });

    refundRate = Math.round(((ticketRefund + depositRefund) / Math.max(1, ticketAmount + depositAmount) * 100) * 100) / 100;
    refundReason = refundReason || `离园结算(${rule.label})`;
    pickingProgress = Math.round(pickRate);
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
    addon_cost: addonCost,
    total_refund: Math.round((ticketRefund + depositRefund) * 100) / 100,
    total_deduction: Math.round(((ticketAmount + depositAmount) - (ticketRefund + depositRefund) + addonCost) * 100) / 100,
    refund_reason: refundReason,
    refund_rate: refundRate,
    picking_progress: pickingProgress,
    actual_picked_weight: params.actualPickedWeight != null ? params.actualPickedWeight : (entry?.actual_picked_weight || 0),
    included_weight: reservation.included_weight || 0,
    deduction_detail: deductionDetail,
    supplement_info: supplementInfo,
    member_arrival: members.length > 0 ? {
      total: totalMembers,
      arrived: arrivedCount,
      rate: Math.round(memberArrivalRate * 100)
    } : null
  };
}

function syncStateToAll(reservationId, source, operator) {
  const reservation = store.getById('reservation', reservationId);
  if (!reservation) return null;
  const entry = store.findOne('entry_record', e => e.reservation_id === reservationId);
  const deposit = store.findOne('deposit_record', d => d.reservation_id === reservationId);
  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const slot = store.getById('time_slot', reservation.slot_id);

  const stateData = {
    reservation: {
      id: reservation.id,
      reservation_no: reservation.reservation_no,
      status: reservation.status,
      visitor_name: reservation.visitor_name,
      visitor_phone: reservation.visitor_phone,
      group_size: reservation.group_size,
      estimated_weight: reservation.estimated_weight,
      included_weight: reservation.included_weight,
      total_amount: reservation.total_amount,
      deposit_amount: reservation.deposit_amount,
      refund_amount: reservation.refund_amount,
      payment_status: reservation.payment_status,
      slot_id: reservation.slot_id,
      ticket_id: reservation.ticket_id,
      cancel_reason: reservation.cancel_reason,
      cancelled_at: reservation.cancelled_at,
      completed_at: reservation.completed_at
    },
    entry: entry ? {
      id: entry.id,
      entry_no: entry.entry_no,
      entry_status: entry.entry_status,
      entry_time: entry.entry_time,
      leave_time: entry.leave_time,
      actual_picked_weight: entry.actual_picked_weight,
      picking_progress: entry.picking_progress
    } : null,
    deposit: deposit ? {
      id: deposit.id,
      status: deposit.status,
      remaining_amount: deposit.remaining_amount,
      refunded_amount: deposit.refunded_amount,
      deducted_amount: deposit.deducted_amount
    } : null,
    ticket: ticket ? {
      id: ticket.id,
      ticket_name: ticket.ticket_name,
      included_weight: ticket.included_weight,
      extra_price_per_kg: ticket.extra_price_per_kg
    } : null,
    slot: slot ? {
      id: slot.id,
      slot_label: slot.slot_label,
      slot_date: slot.slot_date,
      slot_start: slot.slot_start,
      slot_end: slot.slot_end,
      status: slot.status
    } : null
  };

  store.insert('state_sync_log', {
    reservation_id: reservationId,
    source: source || 'SYSTEM',
    operator: operator || 'system',
    state_data: JSON.stringify(stateData),
    synced_at: nowDateTime()
  });

  return stateData;
}

module.exports = {
  REFUND_RULES,
  nowDate,
  nowDateTime,
  daysBetween,
  isBlacklisted,
  isClosureDate,
  getActiveZonesBySlot,
  calcSlotAvailableWeight,
  calcSlotDetailAvailability,
  calcTicketWeight,
  tryLockWeight,
  releaseLockedWeight,
  fullyReleaseLockedWeight,
  recalcAfterMaturityChange,
  processWaitlistPromotion,
  tryCalcRefund,
  syncStateToAll
};
