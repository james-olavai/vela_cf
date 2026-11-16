import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { SubjectsSchema, ProfileInputSchema, type ProfileInput } from '@vela-cf/shared';
import { getCountryChart, recommendCountry, countrySnapshot, type CountrySnapshot } from './country-charts.js';
import { resolveProfileLocation } from './locations.js';

// Reject invalid local dates, timezone gaps and folds rather than guessing an instant.
export function validateBirthTime(datetime: string, timezone: string): void {
  const target = Date.parse(`${datetime}:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== datetime) throw new HttpsError('invalid-argument', 'INVALID_BIRTH_DATETIME');
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new HttpsError('invalid-argument', 'INVALID_TIMEZONE'); }
  const local = (instant: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    return Date.parse(`${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  };
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) { const probe = target + hours * 3600000; offsets.add(local(probe) - probe); }
  const matches = [...offsets].filter(offset => local(target - offset) === target);
  if (!matches.length) throw new HttpsError('invalid-argument', 'NONEXISTENT_BIRTH_TIME');
  if (matches.length > 1) throw new HttpsError('invalid-argument', 'AMBIGUOUS_BIRTH_TIME');
}

export interface FrozenSubject { ref: string; profileId?: string; profile: ProfileInput; countryChart?: CountrySnapshot }
export async function resolveSubjects(db: Firestore, uid: string, rawSubjects: unknown): Promise<FrozenSubject[]> {
  const subjects = SubjectsSchema.parse(rawSubjects);
  const resolved = await Promise.all(subjects.map(async subject => {
    if ('country_chart' in subject) return undefined;
    if ('profile_id' in subject) {
      if (!uid) throw new HttpsError('unauthenticated', 'AUTH_REQUIRED');
      const snap = await db.collection('users').doc(uid).collection('profiles').doc(subject.profile_id).get();
      if (!snap.exists) throw new HttpsError('not-found', 'PROFILE_NOT_FOUND');
      const raw = snap.data()!;
      const parsed = ProfileInputSchema.safeParse(raw);
      if (!parsed.success) throw new HttpsError('failed-precondition', 'INVALID_STORED_PROFILE');
      return { ref: subject.ref, profileId: subject.profile_id, profile: {...parsed.data,...(raw.countryCode && raw.locationSource ? {countryCode:raw.countryCode,locationSource:raw.locationSource} : {})} };
    }
    const { datetime, ...birth } = subject.birth;
    validateBirthTime(datetime, birth.timezone);
    const located = await resolveProfileLocation(db, {name:subject.ref,...(!birth.locationRef?{locationName:'Coordinates'}:{}),...birth,birthDateTime:datetime});
    return {ref:subject.ref,profile:{...ProfileInputSchema.parse(located),...(located.countryCode?{countryCode:located.countryCode,locationSource:located.locationSource}:{})}};
  }));
  return subjects.map((subject,index) => {
    if (!('country_chart' in subject)) return resolved[index]!;
    if (!uid) throw new HttpsError('unauthenticated','AUTH_REQUIRED');
    const ref = subject.country_chart;
    let snapshot: CountrySnapshot;
    if ('mode' in ref) {
      const source = resolved.find(item=>item?.ref===ref.source_ref);
      if (!source || source.profile.entityType==='country') throw new HttpsError('invalid-argument','INVALID_COUNTRY_SOURCE_REF');
      const recommended = recommendCountry(source.profile);
      if (!recommended.chart || recommended.status!=='matched') throw new HttpsError('failed-precondition',recommended.reason||'COUNTRY_CHART_UNAVAILABLE');
      snapshot=countrySnapshot(recommended.chart,{sourceRef:ref.source_ref,basis:recommended.basis as 'birth_location'|'registration_location'});
    } else snapshot=countrySnapshot(getCountryChart(ref.id,ref.version));
    const datetime=`${snapshot.localDate}T${snapshot.localTime}`;
    validateBirthTime(datetime,snapshot.timezone);
    return {ref:subject.ref,countryChart:snapshot,profile:ProfileInputSchema.parse({name:snapshot.name,entityType:'country',birthDateTime:datetime,locationName:snapshot.placeLabel,latitude:snapshot.latitude,longitude:snapshot.longitude,timezone:snapshot.timezone})};
  });
}
