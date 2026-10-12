// Virtualised list: only the rows on screen exist in the DOM, so 200k files
// scroll as smoothly as 20.

export class VList {
  constructor(el, { rowHeight, render, isSelected }) {
    this.el = el;
    this.isSelected = isSelected || null; // (index) => bool, for multi-selection; default: index === selected
    this.rowH = rowHeight;
    this.render = render; // (rowEl, item, index) => void
    this.items = [];
    this.spacer = document.createElement('div');
    this.spacer.className = 'vlist-spacer';
    el.appendChild(this.spacer);
    this.pool = [];
    this.selected = -1;
    el.addEventListener('scroll', () => this.paint(), { passive: true });
    new ResizeObserver(() => this.paint(true)).observe(el);
  }

  setItems(items) {
    this.items = items;
    this.spacer.style.height = items.length * this.rowH + 'px';
    this.paint(true);
  }

  refresh() { this.paint(true); }

  paint(force) {
    if (this.raf && !force) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const top = this.el.scrollTop, h = this.el.clientHeight;
      const first = Math.max(0, Math.floor(top / this.rowH) - 4);
      const last = Math.min(this.items.length, Math.ceil((top + h) / this.rowH) + 4);
      const need = last - first;
      while (this.pool.length < need) {
        const r = document.createElement('div');
        r.className = 'row';
        this.el.appendChild(r);
        this.pool.push(r);
      }
      for (let k = 0; k < this.pool.length; k++) {
        const r = this.pool[k];
        const i = first + k;
        if (k >= need) { r.style.display = 'none'; r._i = -1; continue; }
        r.style.display = '';
        r.style.transform = `translateY(${i * this.rowH}px)`;
        const item = this.items[i];
        if (force || r._item !== item) { this.render(r, item, i); r._item = item; }
        r._i = i;
        r.classList.toggle('selected', this.isSelected ? this.isSelected(i) : i === this.selected);
        r.classList.toggle('odd', (i & 1) === 1);
      }
    });
  }

  select(i, scroll = true) {
    this.selected = i;
    if (scroll && i >= 0) {
      const top = i * this.rowH, el = this.el;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + this.rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + this.rowH - el.clientHeight;
    }
    this.paint(false);
    for (const r of this.pool) r.classList.toggle('selected', this.isSelected ? r._i >= 0 && this.isSelected(r._i) : r._i === i);
  }

  pageSize() { return Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1); }

  indexFromEvent(e) {
    const r = e.target.closest('.row');
    return r && r._i >= 0 ? r._i : -1;
  }
}
