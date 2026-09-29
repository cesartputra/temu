# Temu 3 — undangan pribadi dan buku tamu digital

Aplikasi pernikahan ini memakai **IndexedDB** pada perangkat dan **SQLite** pada server. Check-in disimpan dahulu dalam satu transaksi dengan antrean pengiriman. Pesan berhasil hanya muncul setelah transaksi lokal selesai. Pengiriman berjalan saat aplikasi terbuka, setelah perubahan, ketika koneksi kembali, dan setiap 30 detik.

## Menjalankan

Memerlukan Python 3.10 atau lebih baru; tidak perlu memasang paket Python.

```sh
python3 server/server.py --port 4173
```

Buka **http://localhost:4173/**. Jangan lagi menjalankan `python3 -m http.server`, karena server statis tidak menyediakan sinkronisasi.

Pada komputer yang menjalankan server, koneksi diaktifkan otomatis melalui endpoint pairing yang dibatasi ke loopback, host lokal, dan permintaan dari asal yang sama. Aplikasi menyimpan kunci koneksi pada database perangkat. Menu Pengaturan menampilkan antrean, waktu sinkronisasi, cadangan, dan konflik.

Server menyimpan `server-data/temu.sqlite3`, kunci `server-data/server-key.txt`, dan cadangan dalam `server-data/backups/`. Direktori dan berkas privat dibuat dengan izin terbatas pada pemilik. Jangan memasukkan direktori data, kunci, atau cadangan ke Git atau mengirimkannya bersama kode.

Pada sesi pengembangan ini server dijalankan dengan `--data-dir work/temu-server` dari direktori percakapan. Data tersebut sengaja tidak dimasukkan ke ZIP kode.

## Data lama dan perangkat tambahan

- Data `localStorage` versi pertama dimigrasikan satu kali ke IndexedDB. Salinan lama tidak dihapus, tetapi tidak lagi dipakai setelah migrasi.
- Buka asal/alamat yang sama agar data browser lama dapat ditemukan. `localhost` dan `127.0.0.1` memiliki ruang penyimpanan berbeda.
- Pada perangkat tambahan, buka alamat HTTPS server, masukkan kunci koneksi di Pengaturan, lalu pilih **Buka acara dari server**. Pilih acara yang sama; jangan membuat daftar terpisah dengan QR berbeda.
- Data yang belum dikirim harus disinkronkan sebelum mengganti acara. Pemilihan acara menyimpan cadangan lokal terlebih dahulu.
- Mode petugas/PIN hanya pembatas antarmuka, bukan autentikasi server. Kunci server memberi akses ke seluruh acara pada instalasi ini. Belum ada akun dan peran petugas di server.

## Offline dan konflik

1. Tunggu status siap offline, lalu muat ulang sekali untuk mengaktifkan cache terbaru.
2. Check-in tetap berjalan tanpa koneksi. Antrean disimpan dalam IndexedDB bersama perubahan, sehingga tetap ada setelah browser ditutup.
3. Aplikasi mencoba mengirim kembali saat dibuka/tersambung. Browser tertutup tidak menjalankan sinkronisasi ini.
4. Setiap operasi memiliki ID tetap. Respons yang hilang dan pengiriman ulang tidak menggandakan kedatangan.
5. Server membandingkan keadaan sebelumnya. Dua perubahan pada undangan yang sama tidak digabung secara diam-diam: operasi yang tidak cocok masuk daftar konflik, beserta isi perubahan lokal.
6. Jumlah hadir memakai keadaan server setelah sinkronisasi. Pengelola memeriksa konflik dan, bila perlu, membuat koreksi/check-in baru setelah memverifikasi orang yang hadir. Menandai konflik diperiksa tidak otomatis menambah kehadiran.
7. Selama perangkat tidak terhubung, aplikasi **tidak bisa mencegah penerimaan orang yang sama di dua pintu secara langsung**. Konflik dapat diketahui setelah tersambung. Kedatangan sah yang bersamaan untuk satu keluarga juga dapat memerlukan pemeriksaan.

Server memakai transaksi SQLite dan daftar ID operasi persisten. Antrean yang dibuat ketika permintaan jaringan sedang berlangsung dipertahankan dan diperiksa terhadap keadaan server. Operasi bertentangan disimpan sebagai konflik; operasi tidak terkait tetap dapat diterapkan.

## Cadangan otomatis

- **Perangkat:** 20 snapshot terakhir sebelum perubahan atau penggantian data akibat sinkronisasi. Tersedia melalui **Lihat cadangan lokal**. Snapshot kosong akibat polling tanpa perubahan tidak menimpa riwayat.
- **Server:** snapshot SQLite konsisten saat startup, setelah perubahan (maksimal sekali per menit), setiap lima menit selama server aktif, serta saat penghentian normal. Menyimpan 48 snapshot terakhir. Kerusakan mendadak dapat menghilangkan perubahan sejak snapshot terakhir; database utama sendiri ditulis setiap transaksi.
- Kegagalan cadangan server dilaporkan terpisah dari keberhasilan penyimpanan database; antarmuka menampilkan waktu cadangan terakhir yang berhasil.
- Cadangan lokal dan server otomatis **tidak dienkripsi oleh aplikasi**. Gunakan enkripsi perangkat/disk. Ekspor manual dengan kata sandi tetap menggunakan AES-GCM.
- Cadangan pada disk yang sama tidak melindungi dari kerusakan/hilangnya seluruh perangkat. Gunakan `--backup-dir` yang menunjuk ke volume cadangan terpisah yang dikelola sendiri; aplikasi tidak otomatis mengirim ke penyimpanan cloud.

Contoh server dengan direktori cadangan terpisah:

```sh
python3 server/server.py --data-dir /path/data-temu --backup-dir /path/volume-cadangan/temu
```

Pemulihan server ke direktori baru:

```sh
python3 server/restore_backup.py /path/cadangan.sqlite3 /path/data-pulih
python3 server/server.py --data-dir /path/data-pulih --port 4174
```

Hentikan server lama sebelum menggantinya pada port yang sama. Skrip menolak menimpa direktori yang sudah ada. Kunci koneksi baru akan dibuat jika tidak menggunakan `TEMU_SERVER_TOKEN`. Klien yang sudah menyimpan revisi lebih baru daripada hasil pemulihan berhenti menyinkronkan untuk mencegah penimpaan data. Ekspor data klien tersebut, periksa selisih dengan salinan pulihan melalui browser/profil terpisah, dan rekonsiliasi sebelum melanjutkan acara. Tidak ada pemulihan mundur otomatis yang menyembunyikan hilangnya perubahan.

Pemulihan snapshot lokal pada acara yang sama mempertahankan riwayat dan menonaktifkan undangan yang tidak ada di snapshot, lalu mengirim perubahan baru. QR yang dipulihkan tetap tunduk pada pemeriksaan konflik server.

## Menggunakan server dari ponsel / internet

Server bawaan hanya mendengarkan `127.0.0.1`, sehingga aman untuk pengembangan lokal. Untuk penggunaan lintas perangkat:

1. Tempatkan server pada komputer/host yang selalu aktif dan disk persisten.
2. Gunakan reverse proxy **HTTPS** dengan asal yang sama untuk halaman dan `/api/`. HTTPS diperlukan untuk kamera dan service worker pada ponsel.
3. Atur `TEMU_ALLOWED_HOSTS` ke hostname yang dipakai, dipisahkan koma. Jika perlu, bind server melalui `--host`; jangan membuka server HTTP mentah ke internet.
4. Atur `TEMU_SERVER_TOKEN` dengan rahasia acak minimal 32 karakter melalui pengelola rahasia host, atau gunakan kunci yang dihasilkan dalam direktori privat.
5. Masukkan kunci tersebut pada perangkat yang dipercaya. Permintaan API membawa bearer token dan tidak dicache service worker. Tidak ada CORS lintas asal.

Kode ini menyertakan server mandiri Python dan digunakan oleh instalasi Helipod acara Cesar & Revalina. Domain aktif dan status deploy tetap perlu diperiksa di Helipod; hosting statis saja tidak menjalankan server Python ini.

## Struktur kode

- `dist/app.js`: formulir, kamera, QR, check-in dan ekspor terenkripsi.
- `dist/storage.js`: transaksi IndexedDB, migrasi, antrean dan snapshot lokal.
- `dist/sync-model.js`: operasi perubahan dan pemeriksaan konflik lokal.
- `dist/sync.js`: pengiriman, rekonsiliasi, pemilihan acara, status serta pemulihan snapshot.
- `dist/sw.js`: cache aplikasi offline; `/api/` selalu memakai jaringan.
- `server/server.py`: API, autentikasi, SQLite dan rotasi snapshot server.
- `server/restore_backup.py`: pemulihan snapshot server tanpa menimpa data lama.

## Pengujian

Node.js diperlukan hanya untuk pengujian JavaScript:

```sh
npm ci
npm test
```

Pengujian menggunakan IndexedDB tiruan yang mengikuti API browser, server Python nyata dan SQLite sementara. Mencakup migrasi/inisialisasi, persistensi antrean, transaksi gagal, tab bersamaan, check-in offline, respons jaringan hilang, pengiriman ulang, konflik dua perangkat, autentikasi API, enkripsi manual, QR, dan integritas cadangan SQLite. Pengujian kamera fisik, penghapusan storage oleh OS, multi-perangkat melalui HTTPS, dan beban 5.000 tamu tetap perlu dilakukan pada perangkat acara.

Pustaka QR dibundel lokal: qrcode-generator 1.4.4 (MIT), jsQR 1.4.0 (Apache-2.0). `fake-indexeddb` hanya untuk tes, bukan aplikasi produksi.

## Mengirim undangan melalui WhatsApp

1. Tambah/Ubah tamu dan isi **Nomor WhatsApp**. Nomor `08…` dinormalisasi menjadi `628…`; nomor internasional juga diterima. Kolom ini opsional agar undangan lama tetap bekerja.
2. Buka **Pengaturan → Informasi acara → Teks undangan WhatsApp**. Gunakan `{nama}`, `{acara}`, `{tanggal}`, `{jumlah}`. Tambahkan alamat dan jam acara dalam teks sesuai kebutuhan.
3. Pada Daftar tamu, tekan **WhatsApp** untuk meninjau nomor, QR, serta pesan. Pesan dapat disunting untuk pengiriman tersebut tanpa mengubah template umum.
4. Pada perangkat yang mendukung berbagi berkas, **Bagikan QR + teks** membuka menu perangkat. Pilih WhatsApp dan penerima yang sesuai. Menu berbagi tidak dapat memilih nomor penerima secara otomatis; pastikan nomor tujuan yang ditampilkan cocok.
5. Jika tidak tersedia, pilih **Unduh QR PNG**, lalu **Buka chat WhatsApp**. Chat menuju nomor tamu dengan teks terisi. Lampirkan PNG yang sudah diunduh sebelum menekan Kirim.
6. Beberapa aplikasi/perangkat tidak meneruskan teks bersama gambar. Gunakan **Salin teks** lalu tempel sebagai pesan atau keterangan gambar.

Nomor dan template ikut tersimpan offline, disinkronkan dan dicadangkan. CSV mendukung kolom opsional `telepon` setelah `nama,jumlah,kelompok`. CSV lama tetap dapat diimpor. Ekspor baru menyertakan `telepon`.

Pembuatan PNG dan penyusunan undangan berjalan lokal. Membuka dan mengirim pesan WhatsApp memerlukan koneksi. Aplikasi tidak mengirim pesan otomatis, tidak mengklaim status terkirim/diterima, dan tidak mengirim massal. Tidak ada pesan yang dikirim selama pengujian pengembangan.

Sumber perilaku integrasi: [WhatsApp Click to Chat](https://faq.whatsapp.com/5913398998672934) untuk nomor internasional dan draf teks; [Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) untuk berbagi berkas dan teks melalui pilihan aplikasi perangkat. Tautan WhatsApp tidak melampirkan berkas lokal secara otomatis.

Pembaruan ini telah melewati 26 pengujian otomatis, termasuk normalisasi nomor, penyusunan tautan pesan, template, serta persistensi nomor dan template di server/cadangan. Pengiriman melalui aplikasi WhatsApp fisik belum diuji; dukungan berbagi file berbeda antarperangkat.

## Undangan pernikahan pribadi — Cesar & Revalina

Halaman `/invite` berisi gerbang akses. Setelah verifikasi, tamu melihat foto, video, tanggal, tempat, peta, dan QR check-in miliknya sendiri. Data acara yang disiapkan: **21 November 2026, Steikhaus Bandung**, dengan jam akad dan resepsi masih akan diinformasikan. Foto dan video sumber milik pengguna dioptimalkan untuk web; versi asli tidak diubah.

### Alur pengelola

1. Isi data tamu, nomor WhatsApp, dan informasi acara; tunggu sinkronisasi selesai.
2. Pada **Daftar tamu → Undangan**, pilih **Pratinjau undangan** untuk melihat tampilan sebagai tamu. Pratinjau pengelola berlaku 10 menit dan tidak mengganti tautan tamu.
3. Pilih **Buat / ganti akses**. Sistem membuat tautan acak dan kode 8 digit yang hanya ditampilkan pada sesi pengelola ini. Simpan kode sebelum menutup aplikasi.
4. Kirim tautan lewat WhatsApp; sampaikan kode akses secara terpisah setelah memastikan nomor penerima. Fitur tidak mengirim pesan atau kode secara otomatis.
5. **Cabut akses** membatalkan halaman undangan dan sesi yang terkait. QR check-in tetap berlaku; nonaktifkan undangan melalui Daftar tamu jika akses masuk acara juga perlu dibatalkan.

Alamat lokal tidak dapat dibagikan kepada ponsel tamu. Untuk distribusi, host aplikasi dan server di HTTPS, lalu isi **Pengaturan → Alamat undangan publik HTTPS**. Origin harus sama dengan aplikasi/API yang dideploy. Jangan mengunggah `private-media` sebagai folder statis publik.

### Proteksi yang diterapkan

- Tautan acak 256 bit berada di fragment URL (tidak dikirim sebagai query HTTP) dan segera dihapus dari bilah alamat setelah dibaca halaman.
- Tautan saja tidak membuka undangan. Kode akses terpisah harus cocok dengan undangan aktif.
- Server menyimpan hash tautan, hash kode scrypt dengan salt, serta hash sesi; kode asli tidak disimpan dalam database.
- Lima kode salah membatasi tautan selama 15 menit; batas tambahan 30 percobaan per alamat koneksi dalam 15 menit. Di belakang proxy, batas koneksi dapat berlaku untuk seluruh pengguna; konfigurasi penerapan perlu memperhitungkan ini.
- Sesi tamu maksimal 24 jam. Cookie `HttpOnly`, `SameSite=Strict`, dan `Secure` pada hostname nonlokal. TLS harus diterminasi oleh reverse proxy HTTPS.
- Link berlaku 180 hari atau sampai dicabut. Tautan baru membatalkan tautan/sesi lama. Menonaktifkan tamu, mengganti QR, atau mengganti nomor membatalkan akses lama setelah perubahan sampai di server.
- Data undangan, foto, dan video diperiksa pada setiap permintaan GET/HEAD/Range. Media disimpan di `private-media/`, di luar `dist/`. Respons memakai `Cache-Control: no-store`; service worker tidak menyimpan halaman pribadi atau API.
- Tamu hanya menerima nama, kuota, dan kode QR sendiri, bukan daftar tamu, nomor telepon, atau PIN pengelola.
- Permintaan perubahan memerlukan penanda permintaan dan pemeriksaan asal; API pengelola tetap memerlukan bearer token. Pairing pengelola otomatis localhost dimatikan jika hostname publik dikonfigurasi melalui `TEMU_ALLOWED_HOSTS`.
- Skrip pemulihan database server mencabut tautan dan sesi lama, agar pemulihan snapshot tidak mengaktifkan kembali akses yang pernah dicabut.

**Batas proteksi:** kode manual memverifikasi kepemilikan kredensial, bukan identitas fisik atau kepemilikan nomor WhatsApp. Orang lain yang menerima *tautan dan kode* masih dapat masuk. Tamu juga dapat menyimpan/screenshot konten yang sudah dilihat; sistem tidak dapat mencabut salinan tersebut. Verifikasi OTP WhatsApp otomatis belum terpasang dan memerlukan penyedia pengiriman. Halaman pribadi memerlukan internet agar status pencabutan dapat diperiksa; QR yang diunduh tetap dapat ditunjukkan untuk check-in offline.

Acuan sesi: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Implementasi ini tidak menggantikan audit keamanan sebelum membuka layanan ke internet.

Berkas tambahan:
- `server/guest_access.py`: kredensial undangan, sesi dan pembatasan percobaan.
- `dist/guest-admin.js`: pembuatan/pencabutan akses dan integrasi WhatsApp.
- `dist/invite.html`, `invite.css`, `invite.js`: halaman undangan tamu.
- `private-media/`: tiga foto dan video web, hanya boleh disajikan lewat endpoint terlindungi.

Pratinjau pengembangan menggunakan port 4174 dan tamu uji terpisah. QR pratinjau tidak berlaku untuk check-in acara sebenarnya. Port 4173 tetap aplikasi utama.

Validasi rilis undangan pribadi: 39 pengujian otomatis lulus. Pratinjau browser berhasil membuka undangan dengan kode yang benar, memuat semua foto, dan memiliki lebar halaman 390 px pada viewport ponsel 390 px.
