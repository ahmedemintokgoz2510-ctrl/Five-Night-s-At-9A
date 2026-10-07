# Five Night's At 9A
**Developer: dextomoser**

Akıllı tahtada oynanan HTML5 korku oyunu; telefon QR kodla bağlanıp gamepad olarak kullanılır.

## Yerelde çalıştırma
```
npm install
npm start      # http://localhost:3000
```

## Render.com
1. Klasörü bir GitHub deposuna yükleyin.
2. Render > New > Web Service > depoyu seçin (`render.yaml` otomatik okunur).
   - Build Command: `npm install`  |  Start Command: `npm start`
3. Tahtada Render adresini açın, telefonla QR kodu okutun.

## Kullanım
- Tahta: `https://<uygulama>.onrender.com/`
- Telefon: QR ile açılan `/gamepad.html?game=...&token=...`
- Buton koordinatlarını ayarlamak için tahtada `/?debug=1` açın (Kalibrasyon paneli).
  Ayarlar o tarayıcının localStorage'ına kaydedilir.
