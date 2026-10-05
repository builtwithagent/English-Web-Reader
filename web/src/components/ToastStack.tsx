/**
 * 轻提示。纯展示 —— 队列与生命周期由 App 持有。
 */

export interface ToastItem {
  id: number;
  message: string;
}

export function ToastStack({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {items.map((item) => (
        <div className="toast" key={item.id}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
