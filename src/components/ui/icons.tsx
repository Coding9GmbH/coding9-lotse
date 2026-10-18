// Line icons (24px grid, 1.8 stroke), inline, no dependency.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconChat = (p: P) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></Svg>;
export const IconTarget = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>;
export const IconPalette = (p: P) => (
  <Svg {...p}><path d="M12 21a9 9 0 1 1 9-9c0 2.2-1.8 3.5-3.6 3.5h-1.9a1.7 1.7 0 0 0-1.2 2.9c.4.4.6.9.6 1.4 0 .7-.6 1.2-1.3 1.2H12Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7" r="1" /><circle cx="15.5" cy="7.5" r="1" /></Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
);
export const IconHistory = (p: P) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></Svg>;
export const IconPanel = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconTrash = (p: P) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12 4.5 4.5L19 7" /></Svg>;
export const IconPin = (p: P) => <Svg {...p}><path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10Z" /><circle cx="12" cy="11" r="2" /></Svg>;
export const IconCamera = (p: P) => <Svg {...p}><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" /><circle cx="12" cy="13" r="3.2" /></Svg>;
export const IconBook = (p: P) => <Svg {...p}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15.5H5.5A1.5 1.5 0 0 0 4 20v-15.5Z" /><path d="M4 20a1.5 1.5 0 0 0 1.5 1.5H20M8.5 7.5h7M8.5 11h5" /></Svg>;
export const IconUpload = (p: P) => <Svg {...p}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></Svg>;
export const IconCode = (p: P) => <Svg {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></Svg>;
export const IconEdit = (p: P) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></Svg>;
export const IconArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const IconMore = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>;
export const IconGlobe = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></Svg>;
export const IconMonitor = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>;
export const IconPhone = (p: P) => <Svg {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></Svg>;
export const IconExpand = (p: P) => <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const IconShrink = (p: P) => <Svg {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></Svg>;
export const IconRefresh = (p: P) => <Svg {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6" /><path d="M20 3.5v5.1h-5.1" /></Svg>;
export const IconExternal = (p: P) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
