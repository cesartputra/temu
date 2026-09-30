# Temu — undangan digital dan buku tamu pernikahan

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

Di **Daftar tamu**, pengelola dapat memilih **Reset kehadiran** untuk mengembalikan jumlah hadir semua tamu ke nol dan mengosongkan riwayat check-in. Sambungkan server, selesaikan antrean dan konflik, lalu masukkan kembali PIN pengelola. Nama, kuota, QR, tautan undangan, RSVP, dan doa tidak berubah. Perangkat lain menerima reset saat tersambung; check-in lama yang belum sempat tersinkron tidak akan diterapkan. Cadangan server baru dibuat setelah reset, sedangkan cadangan lokal sebelum reset tidak dapat dipulihkan ke acara yang sama.

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

Kode ini menyertakan server mandiri Python dan digunakan oleh instalasi Helipod acara Reva & Cesar. Domain aktif dan status deploy tetap perlu diperiksa di Helipod; hosting statis saja tidak menjalankan server Python ini.

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
4. Pilih **Unduh QR PNG** untuk menyimpan satu gambar QR.
5. Pilih **Buka WhatsApp dengan teks**. Chat menuju nomor tamu dengan teks terisi. Lampirkan PNG tadi satu kali sebelum menekan Kirim. **Salin teks saja** tersedia bila ingin menempelkan pesan secara manual.
6. Beberapa aplikasi/perangkat tidak meneruskan teks bersama gambar. Gunakan **Salin teks** lalu tempel sebagai pesan atau keterangan gambar.

Nomor dan template ikut tersimpan offline, disinkronkan dan dicadangkan. CSV mendukung kolom opsional `telepon` setelah `nama,jumlah,kelompok`. CSV lama tetap dapat diimpor. Ekspor baru menyertakan `telepon`.

Pembuatan PNG dan penyusunan undangan berjalan lokal. Membuka dan mengirim pesan WhatsApp memerlukan koneksi. Aplikasi tidak mengirim pesan otomatis, tidak mengklaim status terkirim/diterima, dan tidak mengirim massal. Tidak ada pesan yang dikirim selama pengujian pengembangan.

Sumber perilaku integrasi: [WhatsApp Click to Chat](https://faq.whatsapp.com/5913398998672934) untuk nomor internasional dan draf teks. Tautan WhatsApp tidak melampirkan berkas lokal secara otomatis; QR PNG dilampirkan manual agar path lokal browser tidak masuk ke pesan dan gambar tidak terduplikasi.

Pengujian otomatis mencakup normalisasi nomor, penyusunan tautan pesan, template, serta persistensi nomor dan template di server/cadangan. Pengiriman melalui aplikasi WhatsApp fisik tetap perlu diperiksa oleh pengelola sebelum menekan Kirim.

## Undangan pernikahan publik — Reva & Cesar

Halaman `https://forevarwithcesar.helipod.app/invite` terbuka untuk umum tanpa kode masuk. Halaman menampilkan video sampul yang diputar otomatis tanpa suara dan berulang, musik latar dari berkas yang diberikan pengguna, potret, tanggal 21 November 2026, jadwal akad/resepsi yang masih akan diumumkan, Steikhaus Bandung, dan tautan peta. Browser dapat menolak putar otomatis musik bersuara; tombol **Putar musik** selalu tersedia. Desain memakai warna gading, arang, dan emas hangat.

Undangan publik tidak mengirim daftar tamu, nomor telepon, PIN, atau QR masuk. QR check-in tetap dibuat di aplikasi pengelola dan dapat dibagikan melalui WhatsApp kepada masing-masing tamu. Tamu menunjukkan QR itu kepada petugas; jika tidak tersedia, petugas mencari nama pada buku tamu. Pengelola membuka **Daftar tamu → Undangan** untuk menyalin/meninjau tautan publik, atau mengirim tautan bersama QR melalui alur WhatsApp. Pengiriman pesan tetap dilakukan pengguna, bukan otomatis oleh server.

Media asli tidak masuk repository publik. Salinan web `portrait-1.jpg`, `portrait-2.jpg`, `portrait-3.jpg`, `film.mp4`, dan `song.mp3` disimpan pada volume `/data/private-media` dan disajikan oleh endpoint media publik hanya selama acara aktif tersedia. Karena undangan kini publik, siapa pun yang membuka halaman dapat mengakses media tersebut. Aplikasi buku tamu tetap dapat bekerja offline setelah dimuat; halaman undangan dan medianya memerlukan koneksi.

Server masih menyimpan API akses undangan lama untuk kompatibilitas data sebelumnya, tetapi halaman undangan dan pengelola tidak menggunakannya. API pengelola daftar tamu tetap membutuhkan kunci server. Perubahan acara di Pengaturan akan muncul pada halaman publik setelah sinkronisasi.

## Tautan unik, RSVP, dan doa

Setiap tamu aktif mendapat tautan undangan unik dari **Daftar tamu → Undangan** atau saat membuat draf WhatsApp. Tautan memakai tanda tangan acak tersimpan di database server; tidak ada kode masuk. Saat dibuka, halaman menyapa nama tamu dan menambahkan “& Pasangan” untuk kuota dua atau “& Keluarga” untuk kuota lebih dari dua. Tautan umum `/invite` tetap dapat dibaca siapa saja, tetapi RSVP dan kirim doa memerlukan tautan unik. Tautan dapat diteruskan, jadi penerima tautan dapat mengubah RSVP/doa tamu tersebut.

RSVP mencatat hadir (jumlah orang tidak boleh melebihi kuota) atau tidak bisa hadir. Panel **Konfirmasi kehadiran** di daftar tamu menampilkan semua tamu aktif dan ringkasannya dari server. Panel diperbarui ketika daftar dibuka atau tombol **Perbarui** ditekan, sehingga koneksi diperlukan untuk status terbaru; check-in QR tetap berjalan offline. Setiap tamu dapat menulis satu doa dan memperbaruinya. Doa yang dikirim tampil kepada semua pengunjung undangan dengan nama tamu. Hapus/nonaktifkan tamu membuat tautannya tidak berlaku; penghapusan menghapus RSVP dan doanya dari server.

Foto profil pasangan `portrait-cesar.jpg` dan `portrait-revalina.jpg` disimpan di volume media Helipod, bukan GitHub publik.
