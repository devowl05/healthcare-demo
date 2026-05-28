// Inline SVG icons. All inherit `currentColor` so callers control the color.
// Each accepts an optional `size` (defaults to 20) and `className`.

import type { SVGProps } from "react";

type IconProps = {
  size?: number;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, "width" | "height" | "className">;

function baseProps(size: number, className: string | undefined) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function SparkleIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
      <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
    </svg>
  );
}

export function MicIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  );
}

export function StopIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

export function SendIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" />
    </svg>
  );
}

export function TrashIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  );
}

export function SoundOnIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 10v4h4l5 4V6L8 10H4z" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}

export function SoundOffIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 10v4h4l5 4V6L8 10H4z" />
      <path d="M22 9l-6 6" />
      <path d="M16 9l6 6" />
    </svg>
  );
}

export function ToolIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.6-.6-2.5 2.6-2.4z" />
    </svg>
  );
}

export function BrainIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3V4z" />
      <path d="M15 4a3 3 0 0 1 3 3v.5A3 3 0 0 1 20 10a3 3 0 0 1-1 2.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3V4z" />
    </svg>
  );
}

export function ChevronIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function CheckIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 12l5 5 11-11" />
    </svg>
  );
}

export function AlertIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5" />
      <path d="M12 18h.01" />
    </svg>
  );
}

export function PlusCircleIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function CrossIcon({ size = 20, className, ...rest }: IconProps) {
  // Medical/healthcare cross (not a close "x").
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path
        d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function CopyIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function RefreshIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function MenuIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

export function LinkIcon({ size = 20, className, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, className)} {...rest}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </svg>
  );
}
