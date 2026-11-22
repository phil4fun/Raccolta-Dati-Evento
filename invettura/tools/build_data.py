#!/usr/bin/env python3
"""InVettura - prepara ogni notte i dati delle linee dal GTFS di Roma Mobilita'.

Scrive in invettura/data/:
  index.json      elenco linee con i due capolinea di ogni direzione
  cal.json        per ogni data dei prossimi giorni, i servizi (service_id) attivi
  stops.json      per ogni fermata, le linee che la servono
  l/<linea>.json  per ogni linea: percorsi (fermate + minuti dal capolinea) e partenze per servizio

Uso: python3 build_data.py [percorso_o_url_zip] [cartella_uscita]
"""
import csv, io, json, os, re, sys, statistics, urllib.request, zipfile
from array import array
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    ROME = ZoneInfo('Europe/Rome')
except Exception:  # pragma: no cover
    ROME = timezone(timedelta(hours=1))

GTFS_URL = 'https://romamobilita.it/sites/default/files/rome_static_gtfs.zip'
DAYS = 10  # giorni coperti dal calendario


def open_zip(src):
    if re.match(r'https?://', src):
        req = urllib.request.Request(src, headers={'User-Agent': 'InVettura/1.0 (GitHub Actions)'})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        return zipfile.ZipFile(io.BytesIO(data))
    return zipfile.ZipFile(src)


def rows(z, name):
    names = {n.split('/')[-1]: n for n in z.namelist()}
    if name not in names:
        return
    with z.open(names[name]) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline=''))


def tmin(s):
    if not s:
        return None
    h, m, *_ = s.strip().split(':')
    return int(h) * 60 + int(m)


def key(short):
    return re.sub(r'[^A-Za-z0-9]', '_', short)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else GTFS_URL
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data')
    z = open_zip(src)

    # --- calendario: servizi attivi nei prossimi giorni
    today = datetime.now(ROME).date() - timedelta(days=1)  # da ieri: serve per le corse oltre mezzanotte
    dates = [today + timedelta(days=i) for i in range(DAYS + 1)]
    ds = [d.strftime('%Y%m%d') for d in dates]
    active = defaultdict(set)
    for r in rows(z, 'calendar.txt') or []:
        start, end = r['start_date'], r['end_date']
        wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        for d, s in zip(dates, ds):
            if start <= s <= end and r.get(wd[d.weekday()]) == '1':
                active[s].add(r['service_id'])
    for r in rows(z, 'calendar_dates.txt') or []:
        if r['date'] in active or r['date'] in ds:
            if r['exception_type'] == '1':
                active[r['date']].add(r['service_id'])
            else:
                active[r['date']].discard(r['service_id'])
    services = set().union(*active.values()) if active else set()

    # --- fermate, linee, corse
    stop_name = {r['stop_id']: r['stop_name'] for r in rows(z, 'stops.txt')}
    routes = {}
    for r in rows(z, 'routes.txt'):
        routes[r['route_id']] = {
            's': (r.get('route_short_name') or r.get('route_long_name') or r['route_id']).strip(),
            'l': (r.get('route_long_name') or '').strip() if r.get('route_short_name') else '',
            'c': (r.get('route_color') or '').strip(), 't': (r.get('route_text_color') or '').strip(),
            'ty': (r.get('route_type') or '').strip(),
        }
    trips = {}
    for r in rows(z, 'trips.txt'):
        if r['service_id'] not in services or r['route_id'] not in routes:
            continue
        d = r.get('direction_id') or ''
        trips[r['trip_id']] = (r['route_id'], r['service_id'], d, (r.get('trip_headsign') or '').strip())
    print(f'{len(trips)} corse attive su {len(services)} servizi', file=sys.stderr)

    # --- orari di fermata (file grande: letto in streaming, solo le corse attive)
    sid_index, sid_list = {}, []
    tstops, ttimes, tseq = defaultdict(lambda: array('I')), defaultdict(lambda: array('i')), defaultdict(lambda: array('I'))
    for r in rows(z, 'stop_times.txt'):
        tid = r['trip_id']
        if tid not in trips:
            continue
        s = r['stop_id']
        i = sid_index.get(s)
        if i is None:
            i = sid_index[s] = len(sid_list); sid_list.append(s)
        t = tmin(r.get('departure_time') or r.get('arrival_time'))
        tstops[tid].append(i); ttimes[tid].append(t if t is not None else -1); tseq[tid].append(int(r['stop_sequence']))

    # --- per linea e direzione: percorsi, minuti dal capolinea, partenze
    lines = defaultdict(lambda: defaultdict(list))  # short -> dir -> [trip]
    for tid, (rid, svc, d, h) in trips.items():
        if tid in tstops:
            lines[routes[rid]['s']][d or h].append(tid)

    os.makedirs(os.path.join(out, 'l'), exist_ok=True)
    index, stop_lines = [], defaultdict(set)
    for short in sorted(lines, key=lambda s: (len(s), s)):
        rinfo = next(routes[trips[t][0]] for d in lines[short].values() for t in d)
        dirs_out = []
        for dkey in sorted(lines[short]):
            tids = lines[short][dkey]
            pats, pat_of, offs = {}, {}, defaultdict(list)
            for tid in tids:
                order = sorted(range(len(tseq[tid])), key=lambda k: tseq[tid][k])
                st = tuple(tstops[tid][k] for k in order)
                tm = [ttimes[tid][k] for k in order]
                if st not in pats:
                    pats[st] = len(pats)
                pat_of[tid] = pats[st]
                t0 = tm[0]
                offs[st].append([(x - t0) if x >= 0 and t0 >= 0 else None for x in tm])
            # ordina i percorsi per frequenza (il primo e' il principale)
            cnt = Counter(pat_of.values())
            ordered = sorted(pats, key=lambda st: -cnt[pats[st]])
            remap = {pats[st]: i for i, st in enumerate(ordered)}
            pats_out = []
            for st in ordered:
                cols = list(zip(*offs[st]))
                off = []
                for c in cols:
                    v = [x for x in c if x is not None]
                    off.append(int(round(statistics.median(v))) if v else None)
                pats_out.append({'st': [sid_list[i] for i in st], 'off': off, 'n': cnt[pats[st]]})
                for i in st:
                    stop_lines[sid_list[i]].add(short)
            svc = defaultdict(list)
            for tid in tids:
                t0 = next((ttimes[tid][k] for k in sorted(range(len(tseq[tid])), key=lambda k: tseq[tid][k])), None)
                if t0 is None or t0 < 0:
                    continue
                svc[trips[tid][1]].append([t0, remap[pat_of[tid]], tid])
            for v in svc.values():
                v.sort()
            heads = Counter(trips[t][3] for t in tids if trips[t][3])
            main = pats_out[0]['st']
            dirs_out.append({
                'dir': trips[tids[0]][2], 'h': heads.most_common(1)[0][0] if heads else '',
                'f': main[0], 'fn': stop_name.get(main[0], main[0]), 't': main[-1], 'tn': stop_name.get(main[-1], main[-1]),
                'pats': pats_out, 'svc': svc,
            })
        line = {'s': short, 'l': rinfo['l'], 'c': rinfo['c'], 'tc': rinfo['t'], 'ty': rinfo['ty'], 'dirs': dirs_out}
        with open(os.path.join(out, 'l', key(short) + '.json'), 'w', encoding='utf-8') as f:
            json.dump(line, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        index.append({'s': short, 'k': key(short), 'l': rinfo['l'], 'c': rinfo['c'], 'tc': rinfo['t'], 'ty': rinfo['ty'],
                      'd': [{'dir': d['dir'], 'h': d['h'], 'f': d['f'], 'fn': d['fn'], 't': d['t'], 'tn': d['tn']} for d in dirs_out]})

    # rimuove i file di linee non piu' attive
    keep = {key(x['s']) + '.json' for x in index}
    for fn in os.listdir(os.path.join(out, 'l')):
        if fn not in keep:
            os.remove(os.path.join(out, 'l', fn))

    feed = {}
    for r in rows(z, 'feed_info.txt') or []:
        feed = {'start': r.get('feed_start_date', ''), 'end': r.get('feed_end_date', ''), 'version': r.get('feed_version', '')}
    dump = lambda name, obj: json.dump(obj, open(os.path.join(out, name), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    dump('index.json', {'feed': feed, 'lines': index})
    dump('cal.json', {d: sorted(active[d]) for d in ds})
    dump('stops.json', {s: sorted(v) for s, v in stop_lines.items()})
    # per RDE: nome fermata e linee che ci passano (proposte per "Linee interessate")
    nat = lambda x: (len(x), x)
    dump('fermate.json', sorted([s, stop_name.get(s, s), sorted(v, key=nat)] for s, v in stop_lines.items()))
    print(f'{len(index)} linee scritte in {out}', file=sys.stderr)


if __name__ == '__main__':
    main()
