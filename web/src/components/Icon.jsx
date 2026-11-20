export function Icon({ name, size = 16, ...rest }) {
  const paths = ICONS[name] || ICONS.dot;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths}
    </svg>
  );
}

const ICONS = {
  dot: <circle cx="12" cy="12" r="3" />,
  pulse: <path d="M3 12h4l2.5-7 4 14L16 12h5" />,
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  activity: <path d="M3 12h3l3 8 6-16 3 8h3" />,
  check: <path d="m4 12 5 5L20 6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5M12 17.2v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.2" />
    </>
  ),
  undo: <path d="M4 9h11a5 5 0 0 1 0 10h-4M4 9l4-4M4 9l4 4" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14-5L4 8" />
      <path d="M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  arrowRight: <path d="M4 12h16M14 6l6 6-6 6" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
  download: (
    <>
      <path d="M12 3v12M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  shield: <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    </>
  ),
  scale: <path d="M12 3v18M7 21h10M5 7h14M5 7 2 14h6L5 7Zm14 0-3 7h6l-3-7Z" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
};
