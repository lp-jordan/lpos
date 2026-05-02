'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Prospect, ProspectContact, ProspectStatus, ProspectStatusHistory, ProspectUpdate } from '@/lib/models/prospect';
import { ACCOUNT_MODELS, BILLING_STATUSES, EXPANSION_POTENTIALS, PERSON_SOURCES, REVENUE_TYPES } from '@/lib/models/prospect';
import type { UserSummary } from '@/lib/models/user';
import { OwnerAvatar } from '@/components/projects/OwnerAvatar';
import { ContactModal } from '@/components/prospects/ContactModal';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { UpdatesLog } from '@/components/prospects/UpdatesLog';
import { PromoteModal } from '@/components/prospects/PromoteModal';
import { DatePicker } from '@/components/shared/DatePicker';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<ProspectStatus, { bg: string; border: string; color: string }> = {
  prospect: { bg: 'rgba(91,141,217,0.15)',  border: '#5b8dd9', color: '#5b8dd9' },
  active:   { bg: 'rgba(90,185,90,0.15)',   border: '#5ab95a', color: '#5ab95a' },
  inactive: { bg: 'rgba(120,120,120,0.15)', border: '#888',    color: '#888'    },
};

const STATUS_LABELS: Record<ProspectStatus, string> = {
  prospect: 'Prospect',
  active:   'Active Client',
  inactive: 'Inactive',
};

// ── Shared field helpers ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow" style={{ marginBottom: 12 }}>{children}</p>;
}

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="panel" style={{ padding: 20, ...style }}>{children}</div>;
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.75rem', color: 'var(--muted-soft)', fontWeight: 600,
};

const valueStyle: React.CSSProperties = {
  fontSize: '0.875rem', color: 'var(--text)',
};

const inputStyle: React.CSSProperties = {
  padding: '0.35rem 0.6rem', borderRadius: 6,
  border: '1px solid var(--color-border,#444)',
  background: 'var(--color-input-bg,#1a1a1a)',
  color: 'inherit', fontSize: '0.875rem', width: '100%', boxSizing: 'border-box',
};

const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8, alignItems: 'center', minHeight: 28,
};

function Dash() {
  return <span style={{ color: 'var(--muted)' }}>—</span>;
}

function labelFor(options: readonly { value: string; label: string }[], value: string | null): string | null {
  if (!value) return null;
  return options.find((o) => o.value === value)?.label ?? value;
}

function formatMonthDisplay(value: string | null): string {
  if (!value) return '';
  const [y, m] = value.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = parseInt(m, 10) - 1;
  return months[mi] !== undefined ? `${months[mi]} ${y}` : value;
}

function formatDateDisplay(value: string | null): string {
  if (!value) return '';
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatCurrency(value: number | null): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

// ── Overview panel ────────────────────────────────────────────────────────────

function OverviewPanel({ person, onUpdated, readOnly }: { person: Prospect; onUpdated: (p: Prospect) => void; readOnly?: boolean }) {
  const [editing,  setEditing]  = useState(false);
  const [company,  setCompany]  = useState(person.company);
  const [website,  setWebsite]  = useState(person.website  ?? '');
  const [industry, setIndustry] = useState(person.industry ?? '');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  function handleCancel() {
    setCompany(person.company); setWebsite(person.website ?? ''); setIndustry(person.industry ?? '');
    setEditing(false); setError(null);
  }

  async function handleSave() {
    if (!company.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(null);
    try {
      const res  = await fetch(`/api/prospects/${person.prospectId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ company: company.trim(), website, industry }),
      });
      const data = await res.json() as { prospect?: Prospect; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed.');
      onUpdated(data.prospect!);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <SectionLabel>Overview</SectionLabel>
        {!editing && !readOnly && (
          <button type="button" onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-strong)', fontSize: '0.8rem', padding: 0 }}>
            Edit
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>Name</span>
          {editing
            ? <input style={inputStyle} value={company} onChange={(e) => setCompany(e.target.value)} autoFocus disabled={saving} />
            : <span style={{ ...valueStyle, fontWeight: 600 }}>{person.company}</span>}
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Website</span>
          {editing
            ? <input style={inputStyle} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="acme.io" disabled={saving} />
            : <span style={valueStyle}>{person.website || <Dash />}</span>}
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Industry</span>
          {editing
            ? <input style={inputStyle} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Manufacturing" disabled={saving} />
            : <span style={valueStyle}>{person.industry || <Dash />}</span>}
        </div>
        {person.clientName && (
          <div style={rowStyle}>
            <span style={labelStyle}>Projects</span>
            <Link
              href={`/projects?client=${encodeURIComponent(person.clientName)}`}
              style={{ ...valueStyle, fontWeight: 600, color: STATUS_STYLE.active.color, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {person.clientName}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </Link>
          </div>
        )}
      </div>

      {error && <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.82rem', marginTop: 8 }}>{error}</p>}

      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" className="modal-btn-ghost" style={{ padding: '0.3rem 0.8rem', fontSize: '0.82rem' }} onClick={handleCancel} disabled={saving}>Cancel</button>
          <button type="button" className="modal-btn-primary" style={{ padding: '0.3rem 0.8rem', fontSize: '0.82rem' }} onClick={handleSave} disabled={saving || !company.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </Panel>
  );
}

// ── Account panel ─────────────────────────────────────────────────────────────

function CurrencyInput({ value, onChange, disabled, step = 100 }: { value: string; onChange: (v: string) => void; disabled: boolean; step?: number }) {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-soft)', fontSize: '0.875rem', pointerEvents: 'none' }}>$</span>
      <input style={{ ...inputStyle, paddingLeft: 20 }} type="number" min="0" step={step} placeholder="0" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </div>
  );
}

function AccountPanel({ person, onUpdated }: { person: Prospect; onUpdated: (p: Prospect) => void }) {
  const [editing, setEditing] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const isProspect = person.status === 'prospect';

  // Prospect edit state
  const [source,        setSource]        = useState(person.source              ?? '');
  const [accountModel,  setAccountModel]  = useState(person.accountModel        ?? '');
  const [revenueType,   setRevenueType]   = useState(person.revenueType         ?? '');
  const [oneTime,       setOneTime]       = useState(person.oneTimeLpRevenue?.toString()        ?? '');
  const [monthly,       setMonthly]       = useState(person.monthlyLpRevenue?.toString()        ?? '');
  const [tech,          setTech]          = useState(person.monthlyLpTechRevenue?.toString()    ?? '');
  const [fye,           setFye]           = useState(person.estimatedFirstYearValue?.toString() ?? '');
  const [expectedStart, setExpectedStart] = useState(person.expectedStartMonth ?? null);
  const [expansion,     setExpansion]     = useState(person.expansionPotential  ?? '');

  // Active client edit state
  const [activeServices, setActiveServices] = useState(person.activeServices         ?? '');
  const [firstBillDate,  setFirstBillDate]  = useState(person.firstRecurringBillDate ?? null);
  const [billingStatus,  setBillingStatus]  = useState(person.recurringBillingStatus ?? '');
  const [renewalDate,    setRenewalDate]    = useState(person.renewalDate            ?? null);
  const [nextFilmDate,   setNextFilmDate]   = useState(person.nextFilmDate           ?? null);

  function handleCancel() {
    if (isProspect) {
      setSource(person.source ?? ''); setAccountModel(person.accountModel ?? '');
      setRevenueType(person.revenueType ?? '');
      setOneTime(person.oneTimeLpRevenue?.toString() ?? '');
      setMonthly(person.monthlyLpRevenue?.toString() ?? '');
      setTech(person.monthlyLpTechRevenue?.toString() ?? '');
      setFye(person.estimatedFirstYearValue?.toString() ?? '');
      setExpectedStart(person.expectedStartMonth ?? null);
      setExpansion(person.expansionPotential ?? '');
    } else {
      setActiveServices(person.activeServices ?? '');
      setFirstBillDate(person.firstRecurringBillDate ?? null);
      setRevenueType(person.revenueType ?? '');
      setBillingStatus(person.recurringBillingStatus ?? '');
      setMonthly(person.monthlyLpRevenue?.toString() ?? '');
      setTech(person.monthlyLpTechRevenue?.toString() ?? '');
      setRenewalDate(person.renewalDate ?? null);
      setNextFilmDate(person.nextFilmDate ?? null);
    }
    setEditing(false); setError(null);
  }

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const body: Record<string, unknown> = isProspect
        ? {
            source:                  source || null,
            accountModel:            accountModel || null,
            revenueType:             revenueType || null,
            oneTimeLpRevenue:        oneTime ? parseFloat(oneTime) : null,
            monthlyLpRevenue:        monthly ? parseFloat(monthly) : null,
            monthlyLpTechRevenue:    tech ? parseFloat(tech) : null,
            estimatedFirstYearValue: fye ? parseFloat(fye) : null,
            expectedStartMonth:      expectedStart,
            expansionPotential:      expansion || null,
          }
        : {
            activeServices:         activeServices || null,
            firstRecurringBillDate: firstBillDate,
            revenueType:            revenueType || null,
            recurringBillingStatus: billingStatus || null,
            monthlyLpRevenue:       monthly ? parseFloat(monthly) : null,
            monthlyLpTechRevenue:   tech ? parseFloat(tech) : null,
            renewalDate:            renewalDate,
            nextFilmDate:           nextFilmDate,
          };
      const res  = await fetch(`/api/prospects/${person.prospectId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify(body),
      });
      const data = await res.json() as { prospect?: Prospect; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed.');
      onUpdated(data.prospect!);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <SectionLabel>Account</SectionLabel>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-strong)', fontSize: '0.8rem', padding: 0 }}>
            Edit
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {isProspect ? (
          <>
            <div style={rowStyle}>
              <span style={labelStyle}>Source</span>
              {editing
                ? <select style={inputStyle} value={source} onChange={(e) => setSource(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {PERSON_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(PERSON_SOURCES, person.source) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Account Model</span>
              {editing
                ? <select style={inputStyle} value={accountModel} onChange={(e) => setAccountModel(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {ACCOUNT_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(ACCOUNT_MODELS, person.accountModel) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Revenue Type</span>
              {editing
                ? <select style={inputStyle} value={revenueType} onChange={(e) => setRevenueType(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {REVENUE_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(REVENUE_TYPES, person.revenueType) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>One-Time Revenue</span>
              {editing
                ? <CurrencyInput value={oneTime} onChange={setOneTime} disabled={saving} />
                : <span style={valueStyle}>{person.oneTimeLpRevenue !== null ? formatCurrency(person.oneTimeLpRevenue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Monthly LP Revenue</span>
              {editing
                ? <CurrencyInput value={monthly} onChange={setMonthly} disabled={saving} />
                : <span style={valueStyle}>{person.monthlyLpRevenue !== null ? formatCurrency(person.monthlyLpRevenue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Monthly LP Tech</span>
              {editing
                ? <CurrencyInput value={tech} onChange={setTech} disabled={saving} step={50} />
                : <span style={valueStyle}>{person.monthlyLpTechRevenue !== null ? formatCurrency(person.monthlyLpTechRevenue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Est. First-Year</span>
              {editing
                ? <CurrencyInput value={fye} onChange={setFye} disabled={saving} />
                : <span style={valueStyle}>{person.estimatedFirstYearValue !== null ? formatCurrency(person.estimatedFirstYearValue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Expected Start</span>
              {editing
                ? <DatePicker value={expectedStart} onChange={setExpectedStart} mode="month" placeholder="Select month" disabled={saving} />
                : <span style={valueStyle}>{formatMonthDisplay(person.expectedStartMonth) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Expansion</span>
              {editing
                ? <select style={inputStyle} value={expansion} onChange={(e) => setExpansion(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {EXPANSION_POTENTIALS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(EXPANSION_POTENTIALS, person.expansionPotential) || <Dash />}</span>}
            </div>
          </>
        ) : (
          <>
            <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
              <span style={{ ...labelStyle, paddingTop: 4 }}>Active Services</span>
              {editing
                ? <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} value={activeServices} onChange={(e) => setActiveServices(e.target.value)} placeholder="Strategy retainer, monthly video production…" disabled={saving} />
                : <span style={{ ...valueStyle, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{person.activeServices || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>First Bill Date</span>
              {editing
                ? <DatePicker value={firstBillDate} onChange={setFirstBillDate} mode="date" placeholder="Select date" disabled={saving} />
                : <span style={valueStyle}>{formatDateDisplay(person.firstRecurringBillDate) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Revenue Type</span>
              {editing
                ? <select style={inputStyle} value={revenueType} onChange={(e) => setRevenueType(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {REVENUE_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(REVENUE_TYPES, person.revenueType) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Billing Status</span>
              {editing
                ? <select style={inputStyle} value={billingStatus} onChange={(e) => setBillingStatus(e.target.value)} disabled={saving}>
                    <option value="">—</option>
                    {BILLING_STATUSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                : <span style={valueStyle}>{labelFor(BILLING_STATUSES, person.recurringBillingStatus) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Monthly LP Revenue</span>
              {editing
                ? <CurrencyInput value={monthly} onChange={setMonthly} disabled={saving} />
                : <span style={valueStyle}>{person.monthlyLpRevenue !== null ? formatCurrency(person.monthlyLpRevenue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Monthly LP Tech</span>
              {editing
                ? <CurrencyInput value={tech} onChange={setTech} disabled={saving} step={50} />
                : <span style={valueStyle}>{person.monthlyLpTechRevenue !== null ? formatCurrency(person.monthlyLpTechRevenue) : <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Renewal Date</span>
              {editing
                ? <DatePicker value={renewalDate} onChange={setRenewalDate} mode="date" placeholder="Select date" disabled={saving} />
                : <span style={valueStyle}>{formatDateDisplay(person.renewalDate) || <Dash />}</span>}
            </div>

            <div style={rowStyle}>
              <span style={labelStyle}>Next Film Date</span>
              {editing
                ? <DatePicker value={nextFilmDate} onChange={setNextFilmDate} mode="date" placeholder="Select date" disabled={saving} />
                : <span style={valueStyle}>{formatDateDisplay(person.nextFilmDate) || <Dash />}</span>}
            </div>
          </>
        )}
      </div>

      {error && <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.82rem', marginTop: 8 }}>{error}</p>}

      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" className="modal-btn-ghost" style={{ padding: '0.3rem 0.8rem', fontSize: '0.82rem' }} onClick={handleCancel} disabled={saving}>Cancel</button>
          <button type="button" className="modal-btn-primary" style={{ padding: '0.3rem 0.8rem', fontSize: '0.82rem' }} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </Panel>
  );
}

// ── Contacts panel ────────────────────────────────────────────────────────────

function ContactsPanel({ personId, contacts, onChange }: { personId: string; contacts: ProspectContact[]; onChange: (c: ProspectContact[]) => void }) {
  const [modal, setModal] = useState<'new' | string | null>(null);

  function handleSaved(contact: ProspectContact) {
    const exists = contacts.find((c) => c.contactId === contact.contactId);
    onChange(exists ? contacts.map((c) => c.contactId === contact.contactId ? contact : c) : [...contacts, contact]);
    setModal(null);
  }

  function handleDeleted(contactId: string) {
    onChange(contacts.filter((c) => c.contactId !== contactId));
    setModal(null);
  }

  return (
    <Panel>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <SectionLabel>Contacts</SectionLabel>
        <button type="button" onClick={() => setModal('new')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-strong)', fontSize: '0.8rem', padding: 0 }}>
          + Add
        </button>
      </div>

      {contacts.length === 0 && <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0 }}>No contacts yet.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {contacts.map((c) => (
          <button
            key={c.contactId}
            type="button"
            onClick={() => setModal(c.contactId)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.5rem 0.4rem', borderRadius: 6, border: 'none',
              background: 'none', cursor: 'pointer', textAlign: 'left', width: '100%',
              transition: 'background 120ms ease',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
          >
            <div>
              <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-strong)' }}>{c.name}</span>
              {c.role && <span style={{ fontSize: '0.78rem', color: 'var(--muted)', marginLeft: 8 }}>{c.role}</span>}
            </div>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--muted-soft)', flexShrink: 0 }}>
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        ))}
      </div>

      {modal === 'new' && <ContactModal prospectId={personId} contact={null} onSaved={handleSaved} onClose={() => setModal(null)} />}
      {modal && modal !== 'new' && (() => {
        const c = contacts.find((x) => x.contactId === modal);
        return c ? <ContactModal prospectId={personId} contact={c} onSaved={handleSaved} onDeleted={handleDeleted} onClose={() => setModal(null)} /> : null;
      })()}
    </Panel>
  );
}

// ── Assigned users row ────────────────────────────────────────────────────────

function AssignedUsersRow({ person, accessUsers, onUpdated }: { person: Prospect; accessUsers: UserSummary[]; onUpdated: (p: Prospect) => void }) {
  const [showPicker, setShowPicker] = useState(false);
  const [saving,     setSaving]     = useState(false);
  const pickerRef = useRef<HTMLSelectElement>(null);

  const assigned   = accessUsers.filter((u) => person.assignedTo.includes(u.id));
  const unassigned = accessUsers.filter((u) => !person.assignedTo.includes(u.id));

  async function handleAdd(userId: string) {
    if (!userId) return;
    setSaving(true);
    try {
      const res  = await fetch(`/api/prospects/${person.prospectId}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      const data = await res.json() as { prospect?: Prospect };
      if (res.ok && data.prospect) onUpdated(data.prospect);
    } finally { setSaving(false); setShowPicker(false); }
  }

  async function handleRemove(userId: string) {
    setSaving(true);
    try {
      const res  = await fetch(`/api/prospects/${person.prospectId}/users`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
      const data = await res.json() as { prospect?: Prospect };
      if (res.ok && data.prospect) onUpdated(data.prospect);
    } finally { setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.78rem', color: 'var(--muted-soft)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Assigned</span>
      {assigned.map((u) => (
        <div key={u.id} style={{ position: 'relative', display: 'inline-flex' }}
          onMouseEnter={(e) => { const b = e.currentTarget.querySelector<HTMLButtonElement>('.remove-btn'); if (b) b.style.opacity = '1'; }}
          onMouseLeave={(e) => { const b = e.currentTarget.querySelector<HTMLButtonElement>('.remove-btn'); if (b) b.style.opacity = '0'; }}
        >
          <OwnerAvatar user={u} size={28} />
          <button
            className="remove-btn"
            type="button"
            onClick={() => handleRemove(u.id)}
            disabled={saving}
            title={`Remove ${u.name}`}
            style={{
              position: 'absolute', top: -4, right: -4, width: 14, height: 14, borderRadius: '50%',
              background: 'var(--color-error,#e55)', border: 'none', color: '#fff',
              fontSize: 9, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', opacity: 0, transition: 'opacity 120ms ease', padding: 0, lineHeight: 1,
            }}
          >×</button>
        </div>
      ))}
      {unassigned.length > 0 && !showPicker && (
        <button
          type="button"
          onClick={() => { setShowPicker(true); setTimeout(() => pickerRef.current?.focus(), 50); }}
          disabled={saving}
          style={{ padding: '2px 10px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600, border: '1px dashed var(--color-border,#444)', background: 'none', color: 'var(--muted)', cursor: 'pointer' }}
        >
          + Add
        </button>
      )}
      {showPicker && (
        <select
          ref={pickerRef}
          defaultValue=""
          onChange={(e) => handleAdd(e.target.value)}
          onBlur={() => setShowPicker(false)}
          disabled={saving}
          style={{ padding: '0.25rem 0.5rem', borderRadius: 6, fontSize: '0.82rem', border: '1px solid var(--accent)', background: 'var(--color-input-bg,#1a1a1a)', color: 'inherit', cursor: 'pointer' }}
        >
          <option value="">Select user…</option>
          {unassigned.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Overflow menu ─────────────────────────────────────────────────────────────

function OverflowMenu({ person, onArchiveToggle }: { person: Prospect; onArchiveToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'none', border: '1px solid var(--color-border,#444)', borderRadius: 6, cursor: 'pointer', color: 'var(--muted)', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', lineHeight: 1 }}
        aria-label="More options"
      >···</button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--surface-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 0', minWidth: 160, zIndex: 50, boxShadow: 'var(--shadow-md)' }}>
            <button
              type="button"
              onClick={() => { setOpen(false); onArchiveToggle(); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.45rem 1rem', background: 'none', border: 'none', fontSize: '0.875rem', color: 'var(--text)', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              {person.archived ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  initialPerson:        Prospect;
  initialContacts:      ProspectContact[];
  initialStatusHistory: ProspectStatusHistory[];
  initialUpdates:       ProspectUpdate[];
  accessUsers:          UserSummary[];
  allUsers:             UserSummary[];
  currentUser:          UserSummary | null;
}

export function PersonDetailClient({ initialPerson, initialContacts, initialUpdates, accessUsers, allUsers, currentUser }: Props) {
  const router = useRouter();

  const [person,         setPerson]         = useState(initialPerson);
  const [contacts,       setContacts]       = useState(initialContacts);
  const [savingStatus,   setSavingStatus]   = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [savingArchive,  setSavingArchive]  = useState(false);
  const [showPromote,    setShowPromote]    = useState(false);

  const statusStyle  = STATUS_STYLE[person.status];
  const isProspect   = person.status === 'prospect';
  const isActive     = person.status === 'active' || person.status === 'inactive';

  async function handleStatusChange(newStatus: ProspectStatus) {
    if (newStatus === person.status) return;
    setSavingStatus(true);
    try {
      const res  = await fetch(`/api/prospects/${person.prospectId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ status: newStatus }),
      });
      const data = await res.json() as { prospect?: Prospect };
      if (res.ok && data.prospect) setPerson(data.prospect);
    } finally { setSavingStatus(false); }
  }

  async function handleArchiveToggle() {
    if (!confirmArchive) { setConfirmArchive(true); return; }
    setSavingArchive(true);
    try {
      const res  = await fetch(`/api/prospects/${person.prospectId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ archived: !person.archived }),
      });
      const data = await res.json() as { prospect?: Prospect };
      if (res.ok && data.prospect) { setPerson(data.prospect); router.refresh(); }
    } finally { setSavingArchive(false); setConfirmArchive(false); }
  }

  async function handlePromote(clientName: string) {
    const res  = await fetch(`/api/prospects/${person.prospectId}/promote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ clientName }),
    });
    const data = await res.json() as { prospect?: Prospect; error?: string };
    if (!res.ok) throw new Error(data.error ?? 'Promotion failed.');
    setPerson(data.prospect!);
    setShowPromote(false);
    router.refresh();
  }

  return (
    <div className="page-stack">

      {/* ── Header ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 20, borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link
            href="/people"
            style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', fontSize: '0.82rem', textDecoration: 'none', flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            People
          </Link>

          <h1 style={{ margin: 0, fontSize: '1.4rem', letterSpacing: '-0.03em', color: 'var(--text-strong)', flex: 1 }}>
            {person.company}
          </h1>

          {/* Status display / toggle */}
          {isProspect ? (
            <span style={{
              display: 'inline-block', padding: '0.28rem 0.8rem', borderRadius: 999,
              border: `1px solid ${statusStyle.border}`, background: statusStyle.bg,
              color: statusStyle.color, fontSize: '0.8rem', fontWeight: 600,
            }}>
              Prospect
            </span>
          ) : (
            <select
              value={person.status}
              onChange={(e) => handleStatusChange(e.target.value as ProspectStatus)}
              disabled={savingStatus}
              style={{
                padding: '0.28rem 2rem 0.28rem 0.7rem', borderRadius: 999,
                border: `1px solid ${statusStyle.border}`, backgroundColor: statusStyle.bg,
                color: statusStyle.color, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(statusStyle.color)}' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                backgroundPosition: 'right 8px center', backgroundRepeat: 'no-repeat',
              }}
            >
              <option value="active">Active Client</option>
              <option value="inactive">Inactive</option>
            </select>
          )}

          {isProspect && (
            <button
              type="button"
              onClick={() => setShowPromote(true)}
              style={{ padding: '0.3rem 1rem', borderRadius: 6, fontSize: '0.82rem', fontWeight: 600, border: '1px solid var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent-strong)', cursor: 'pointer' }}
            >
              Promote →
            </button>
          )}

          <OverflowMenu person={person} onArchiveToggle={() => setConfirmArchive(true)} />
        </div>

        <AssignedUsersRow person={person} accessUsers={accessUsers} onUpdated={setPerson} />

        {person.archived && (
          <span style={{ display: 'inline-block', padding: '0.2rem 0.7rem', borderRadius: 4, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--color-border,#333)', fontSize: '0.75rem', color: 'var(--muted)', alignSelf: 'flex-start' }}>
            Archived
          </span>
        )}
      </div>

      {/* ── Two-column body ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24, alignItems: 'start' }}>

        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <OverviewPanel person={person} onUpdated={setPerson} />
          <AccountPanel person={person} onUpdated={setPerson} />
          <ContactsPanel personId={person.prospectId} contacts={contacts} onChange={setContacts} />
        </div>

        {/* Right column */}
        <Panel style={{ minHeight: 300 }}>
          <SectionLabel>Updates</SectionLabel>
          <UpdatesLog
            prospectId={person.prospectId}
            initialUpdates={initialUpdates}
            currentUserId={currentUser?.id ?? ''}
            allUsers={allUsers}
            mentionUsers={accessUsers}
          />
        </Panel>
      </div>

      {/* Promote modal */}
      {showPromote && (
        <PromoteModal
          companyName={person.company}
          onConfirm={handlePromote}
          onClose={() => setShowPromote(false)}
        />
      )}

      {/* Archive confirm */}
      {confirmArchive && (
        <ConfirmModal
          title={person.archived ? 'Unarchive?' : 'Archive?'}
          body={person.archived
            ? `Restore ${person.company} to your active list?`
            : `Archive ${person.company}? You can restore it any time.`}
          confirmLabel={person.archived ? 'Unarchive' : 'Archive'}
          onConfirm={handleArchiveToggle}
          onClose={() => setConfirmArchive(false)}
        />
      )}
    </div>
  );
}
