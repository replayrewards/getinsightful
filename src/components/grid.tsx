import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { ReactNode } from "react";
import type { CardSpec } from "../lib/api";

// 12-column bento grid: drag via card header, resize via corner handle,
// compacted vertically. The parent persists layout changes to the warehouse.
export function BentoGrid({
  cards,
  onLayoutChange,
  renderCard,
}: {
  cards: CardSpec[];
  onLayoutChange: (cards: CardSpec[]) => void;
  renderCard: (card: CardSpec) => ReactNode;
}) {
  const { containerRef, width, mounted } = useContainerWidth({ initialWidth: 1200 });
  const layout: Layout = cards.map((c) => ({ i: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));
  // persist on drag/resize stop only — RGL's mount-time onLayoutChange would
  // otherwise save its own normalization over the stored layout
  const settled = (l: Layout) => sync(l, cards, onLayoutChange);
  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: 12, rowHeight: 46, margin: [12, 12], containerPadding: null, maxRows: Infinity }}
          dragConfig={{ enabled: true, bounded: false, handle: ".card-drag", threshold: 3 }}
          resizeConfig={{ enabled: true, handles: ["se"] }}
          compactor={verticalCompactor}
          onDragStop={(l) => settled(l)}
          onResizeStop={(l) => settled(l)}
        >
          {cards.map((c) => (
            <div key={c.id}>{renderCard(c)}</div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

function sync(layout: Layout, cards: CardSpec[], onLayoutChange: (cards: CardSpec[]) => void) {
  onLayoutChange(
    cards.map((c) => {
      const l = layout.find((x) => x.i === c.id);
      return l ? { ...c, x: l.x, y: l.y, w: l.w, h: l.h } : c;
    }),
  );
}
