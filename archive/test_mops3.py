import requests, urllib3
urllib3.disable_warnings()
r = requests.post('https://mopsov.twse.com.tw/mops/web/ajax_t164sb04', data={
    'encodeURIComponent': 1, 'step': 1, 'firstin': 1, 'off': 1,
    'co_id': '1409', 'year': '110', 'season': '1', 'report_id': 'C'
}, verify=False, timeout=60)
r.encoding = 'utf8'
print(f'Length: {len(r.text)}')
print('BLOCKED' if len(r.text) < 2000 else 'OK')
if len(r.text) > 2000:
    print(r.text[:500])
