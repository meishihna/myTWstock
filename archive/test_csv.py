import requests, urllib3
urllib3.disable_warnings()
r = requests.post('https://mopsov.twse.com.tw/mops/web/ajax_t163sb04', data={
    'encodeURIComponent': 1, 'step': 1, 'firstin': 1, 'off': 1,
    'TYPEK': 'sii', 'year': '114', 'season': '1',
}, verify=False, timeout=60)
r.encoding = 'utf8'
print(f'Length: {len(r.text)}')
print('OK' if len(r.text) > 10000 else 'BLOCKED')
