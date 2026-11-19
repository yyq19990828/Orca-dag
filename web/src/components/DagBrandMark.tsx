/**
 * Minimalist fork-join DAG node graph brand mark:
 * one entry node branching smoothly into two parallel worker nodes and
 * converging into a final node. Uses `currentColor` to match light/dark chrome.
 */
export function DagBrandMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Slender fork-and-join Bezier edges */}
      <path
        d="M5.5 12C9 12 8.6 5.5 12 5.5C15.4 5.5 15 12 18.5 12"
        stroke="currentColor"
        strokeOpacity="0.68"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <path
        d="M5.5 12C9 12 8.6 18.5 12 18.5C15.4 18.5 15 12 18.5 12"
        stroke="currentColor"
        strokeOpacity="0.68"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      {/* Entry, parallel middle, and converge nodes */}
      <circle cx="4.5" cy="12" r="2.25" fill="currentColor" />
      <circle cx="12" cy="5.5" r="2.25" fill="currentColor" />
      <circle cx="12" cy="18.5" r="2.25" fill="currentColor" />
      <circle cx="19.5" cy="12" r="2.25" fill="currentColor" />
    </svg>
  );
}
