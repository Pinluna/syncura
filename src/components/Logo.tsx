import type { CSSProperties } from "react";

export function Logo({
  label,
  mark = 26,
  style,
}: {
  label: string;
  mark?: number;
  style?: CSSProperties;
}) {
  return (
    <span className="logoLockup">
      <img className="logoMark" src="/logo.png" alt="" width={mark} height={mark} />
      <span className="wordmark" style={style}>
        {label}
      </span>
    </span>
  );
}