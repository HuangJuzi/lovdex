type QoderLogoProps = {
  className?: string;
};

const QoderLogo = ({ className = 'w-5 h-5' }: QoderLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Qoder"
    className={className}
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2" y="2" width="20" height="20" rx="6" opacity="0.15" />
    <path d="M12 7a5 5 0 1 0 4.9 6h2.6l-1.5-1.5V17h-2v-1.5A5 5 0 0 0 12 7zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
  </svg>
);

export default QoderLogo;
