import requests, urllib3
urllib3.disable_warnings()
r = requests.post('https://mops.twse.com.tw/mops/api/t164sb04', json={
    'companyId': '1409', 'dataType': '2', 'season': '1',
    'year': '110', 'subsidiaryCompanyId': ''
}, verify=False, timeout=60)
print(f'Length: {len(r.text)}')
print('BLOCKED' if len(r.text) < 2000 or '無法執行' in r.text else 'OK')
