export function InventoryStackCount({ quantity }: { quantity: number }) {
  return (
    <span
      role="img"
      aria-label={`Quantity ${quantity}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 1,
        zIndex: 2,
        color: '#ffff00',
        font: '16px/12px "RuneScape Small", sans-serif',
        textShadow: '1px 1px #000',
        pointerEvents: 'none',
      }}
    >
      {quantity}
    </span>
  );
}
