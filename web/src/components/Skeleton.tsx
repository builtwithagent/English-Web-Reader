/**
 * 加载骨架。
 *
 * 抓取 + 提取要一秒钟上下，空白等待会让人以为卡住了。
 * 骨架用两栏形状提前告诉用户"这将是一篇对照阅读"。
 */

export function Skeleton() {
  return (
    <section className="skeleton" aria-hidden="true">
      <div className="sk-line sk-title" />
      <div className="sk-cols">
        <div className="sk-col">
          <div className="sk-line" style={{ width: '96%' }} />
          <div className="sk-line" style={{ width: '88%' }} />
          <div className="sk-line" style={{ width: '92%' }} />
          <div className="sk-line" style={{ width: '70%' }} />
          <div className="sk-line" style={{ width: '94%', marginTop: 26 }} />
          <div className="sk-line" style={{ width: '86%' }} />
          <div className="sk-line" style={{ width: '60%' }} />
        </div>
        <div className="sk-col">
          <div className="sk-line" style={{ width: '94%' }} />
          <div className="sk-line" style={{ width: '90%' }} />
          <div className="sk-line" style={{ width: '96%' }} />
          <div className="sk-line" style={{ width: '66%' }} />
          <div className="sk-line" style={{ width: '92%', marginTop: 26 }} />
          <div className="sk-line" style={{ width: '88%' }} />
          <div className="sk-line" style={{ width: '72%' }} />
        </div>
      </div>
    </section>
  );
}
