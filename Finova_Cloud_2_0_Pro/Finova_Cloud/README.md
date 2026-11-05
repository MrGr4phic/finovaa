# FINOVA CLOUD — Bulut Finans Yönetim Sistemi

Finova'nın **internetten kullanıcı adı ve şifreyle açılabilen** ve **telefon/bilgisayar arasında aynı finans kayıtlarını gösteren** sunuculu sürümü.

> **Durum:** Çalışan uygulama kaynak kodu. Bu ZIP paketi internete yüklenmiş canlı bir hizmet değildir. Gerçek kullanıma açmak için HTTPS alan adı sunan bir barındırma hizmeti ve PostgreSQL veritabanı kurmak gerekir.

## Fonksiyonlar

- **Gerçek kullanıcı adı ve şifre:** 3–32 karakterli kullanıcı adı; en az 12 karakterli şifre. Şifreler `scrypt` ile benzersiz tuz kullanılarak hash'lenir.
- **30 günlük oturum:** Sadece sunucuda hash'i tutulan rastgele oturum anahtarı; `HttpOnly`, `SameSite=Strict` ve üretimde `Secure` çerezi.
- **Kullanıcı izolasyonu:** Farklı kullanıcı adlarının finans verileri birbirinden ayrıdır.
- **Bulut senkronizasyonu:** PostgreSQL üzerinde anlık kayıt; PostgreSQL `LISTEN/NOTIFY` üzerinden Server-Sent Events (SSE), bağlantı koparsa 12 saniyelik kontrol.
- **Çakışma koruması:** İki cihaz aynı veriyi eşzamanlı değiştirirse ikinci eski sürüm sunucuda reddedilir (`409`). Cihazdaki taslak korunur; JSON yedek, yeniden deneme veya buluttakini alma seçenekleri görünür.
- **Finans modülleri:** Gelir/gider, banka/kasa hesapları, cari hesaplar, alacak/borç vadeleri ve kısmi tahsilat/ödeme, finansal raporlar.
- **Dışa aktarma:** Excel uyumlu CSV ve eski Finova ile uyumlu JSON tam yedek / içe aktarma.
- **Güvenlik:** HTTPS üzerinde çalışacak şekilde tasarlanmıştır; CSP, CSRF Origin kontrolü, login hız sınırı, veri/ilişki doğrulaması ve sürüm kontrollü SQL güncellemesi içerir.
- **Şifre değişikliği:** Değiştirildiğinde aynı kullanıcının diğer cihazlarındaki oturumlar iptal edilir.

## Kolay kurulum — Railway + PostgreSQL

1. ZIP'i açın ve `Finova_Cloud` klasöründeki dosyaları **özel (private) bir GitHub deposuna** yükleyin. `.env` dosyasını ve şifreleri depoya eklemeyin.
2. [Railway](https://railway.com/) üzerinden yeni proje oluşturup GitHub deponuzu **Deploy from GitHub repo** seçeneğiyle ekleyin.
3. Aynı Railway projesine **PostgreSQL** servisi ekleyin. Bu, kalıcı veritabanını sağlar.
4. Finova web servisinde **Variables** bölümüne şu değişkenleri ekleyin:

   | Değişken | Üretim değeri |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — PostgreSQL servis adınız farklıysa başvuruyu uyarlayın |
   | `NODE_ENV` | `production` |
   | `ALLOW_SIGNUP` | `true` — İlk kullanıcı hesabını oluşturduktan sonra `false` yapmanız önerilir |
   | `APP_ORIGIN` | Yayınlanan adresin tamamı, örn. `https://finova-ornegi.up.railway.app` |

5. Railway **Networking → Generate Domain** bölümünden HTTPS adresi alın. `APP_ORIGIN` değişkenini bu **kesin HTTPS origin** adresiyle eşleştirip yeniden dağıtımı tamamlayın. `PORT` Railway tarafından otomatik sağlanır.
6. Verilen HTTPS adresini telefonda ve bilgisayarda açın; **Hesap oluştur** ile kullanıcı adı/şifre belirleyin. Aynı hesapla iki cihazdan giriş yapınca kayıtlar senkronize edilir.
7. Güvenlik için ilk hesap oluşturulduktan sonra `ALLOW_SIGNUP=false` yapın; kullanıcı eklemek gerektiğinde kontrollü olarak açabilirsiniz. **PostgreSQL yedeklemelerini Railway üzerinde ayrıca etkinleştirin** ve geri yüklemeyi test edin.

Uygulama ilk açılışta gerekli SQL tablolarını `schema.sql` ile oluşturur; mevcut verileri silmez.

**Railway rehberleri:** https://railway.com/guides/express ve https://docs.railway.com/databases/postgresql

## Yerel geliştirme

Node.js 20+ ve PostgreSQL 14+ gereklidir.

```bash
cp .env.example .env
# .env içindeki DATABASE_URL bilgilerini kendi PostgreSQL bağlantınıza göre düzenleyin.
npm install
npm run dev
```

`http://localhost:3000` adresini açın. `schema.sql` ilk açılışta otomatik işlenir. Prod ortamda HTTP değil **HTTPS** kullanın.

Testler gerçek PostgreSQL kurulumuna ihtiyaç duymadan geçici bir RAM deposunda çalışır:

```bash
npm test
```

Bu RAM deposu yalnızca `NODE_ENV=test` **ve** `FINOVA_TEST_MEMORY=1` beraber ayarlanmışsa kullanılır. Gerçek veriyi kesinlikle bu modda çalıştırmayın.

## Eski Finova kayıtlarınızı aktarmak

1. Önceki `finova_finans_yonetimi.html` sürümünü, kayıtları tuttuğunuz **aynı tarayıcıda** açın.
2. **Veri & Ayarlar → JSON Tam Yedek → İndir** ile `finova-yedek-...json` dosyanızı alın.
3. Finova Cloud'a giriş yapın, **Veri & Ayarlar → Eski Finova Yedeğini Aktar** bölümünden JSON'u yükleyin.
4. İçe aktarmanın **mevcut tüm bulut kayıtlarının üzerine yazdığını** unutmayın; önce bulut JSON yedeği indirin.

Eski yerel veriler, farklı alan adındaki yeni uygulamaya otomatik taşınamaz.

## Veri ve güvenlik sınırları

- **Gerçek banka entegrasyonu yoktur.** Banka bakiyeleri manuel kayıtlarınızdan hesaplanır.
- **Çok kullanıcı arasında aynı şirket verisini paylaşma / rol yönetimi henüz yoktur:** Her kullanıcının ayrı finans çalışma alanı vardır; aynı kullanıcı adıyla birden çok cihazdan oturum açılır. Personel için özel roller ileride eklenebilir.
- **Şifre sıfırlama e-postası, iki adımlı doğrulama, e-fatura/e-defter, otomatik banka mutabakatı, dış sistem entegrasyonları ve mali mevzuat uyumluluğu** bu sürümde bulunmaz.
- İki cihazda aynı anda değişiklik yapılırsa, kayıpları engellemek için çakışma uyarısı gösterilir; otomatik birleştirme yapılmaz.
- **Kalıcı veritabanı yedekleme, izleme, güncelleme, güvenlik testi ve erişim yetkilendirmesi** canlı ortam yöneticisinin sorumluluğundadır. Önemli ticari bilgiler girmeden önce bunları yapılandırın.
- Kullanıcı adı şifresi bilen herkes aynı kullanıcıya ait verileri görebilir. Güçlü, benzersiz parola kullanın.
- Bu bir finans takip uygulamasıdır; yasal muhasebe sistemi ya da banka altyapısı değildir.

## Dosya yapısı

```text
Finova_Cloud/
├── public/index.html     # Türkçe mobil uyumlu arayüz
├── server/index.js       # HTTP API, giriş, oturum, senkronizasyon
├── server/security.js    # Şifreleme, veri doğrulaması
├── server/store.js       # PostgreSQL ve test deposu
├── schema.sql            # Otomatik veritabanı tabloları
├── Dockerfile            # Railway/Docker dağıtımı
├── railway.toml          # Railway sağlık ve başlatma ayarları
├── .env.example          # Yerel ayar örneği
└── test/                 # Backend testleri
```
