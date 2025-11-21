// Popover API 类型定义
// https://developer.mozilla.org/en-US/docs/Web/API/Popover_API

interface HTMLElement {
  popover?: 'auto' | 'manual' | null;
  showPopover(): void;
  hidePopover(): void;
  togglePopover(force?: boolean): boolean;
}

interface HTMLElementTagNameMap {
  div: HTMLDivElement & {
    popover?: 'auto' | 'manual' | null;
  };
}

// 扩展 React 的 HTMLAttributes 以支持 popover 属性
declare namespace React {
  interface HTMLAttributes<T> {
    popover?: 'auto' | 'manual';
  }
}
