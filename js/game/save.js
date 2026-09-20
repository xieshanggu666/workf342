/**
 * FG.Save —— 存档系统：多槽位 localStorage、自动存档、导出/导入
 */
FG.Save = (() => {
  const prefix = FG.Config.SAVE_PREFIX;
  const slots = FG.Config.SAVE_SLOTS;

  function key(slot) { return prefix + slot; }

  function listSlots() {
    return slots.map(id => {
      const raw = localStorage.getItem(key(id));
      if (!raw) return { id, exists: false };
      try {
        const obj = JSON.parse(raw);
        return { id, exists: true, meta: obj.meta };
      } catch (e) {
        return { id, exists: false };
      }
    });
  }

  function saveToSlot(slot, meta, data) {
    const payload = JSON.stringify({ meta, data });
    try {
      localStorage.setItem(key(slot), payload);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  function loadSlot(slot) {
    const raw = localStorage.getItem(key(slot));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function deleteSlot(slot) { localStorage.removeItem(key(slot)); }

  function exportSlot(slot) {
    const raw = localStorage.getItem(key(slot));
    if (!raw) return false;
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'autofactory_slot' + slot + '_' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }

  function importText(text) {
    try {
      const obj = JSON.parse(text);
      if (!obj || !obj.data || !obj.data.v) return null;
      return obj;
    } catch (e) { return null; }
  }

  return { listSlots, saveToSlot, loadSlot, deleteSlot, exportSlot, importText, slots };
})();
