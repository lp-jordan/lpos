export function StatCard({ label, value }: Readonly<{ label: string; value: string | number }>) {
  return (
    <article className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </article>
  );
}
