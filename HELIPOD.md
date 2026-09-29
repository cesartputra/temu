# Deploy Temu ke Helipod

## 1. Siapkan sumber

Gunakan isi folder `tamu-digital` sebagai root repository GitHub/GitLab. Dockerfile harus berada di root repository. Repository ini publik, sehingga `private-media/` diabaikan Git dan Docker. Foto/video/musik dan potret profil harus dipindahkan secara terpisah ke volume privat `/data/private-media` dengan nama `portrait-1.jpg`, `portrait-2.jpg`, `portrait-3.jpg`, dan `portrait-cesar.jpg`, `portrait-revalina.jpg`, `film.mp4`, dan `song.mp3`. Media undangan disajikan publik oleh server selama acara aktif; jangan taruh berkas asli dalam repository publik.

Jangan upload node_modules, server-data, work, .env, kunci server, database, atau cadangan. ZIP kode tidak memuat daftar tamu yang sedang digunakan. Simpan cadangan terenkripsi melalui aplikasi lokal sebelum migrasi.

## 2. Buat layanan

Dashboard Helipod → New Project → GitHub/GitLab → pilih repository dan branch. Gunakan Dockerfile yang disertakan. Build/start command override dapat dikosongkan karena sudah ada CMD pada Dockerfile. Gunakan layanan always-on, satu replica; jangan mengaktifkan autoscaling beberapa replica untuk database SQLite ini.

Tambahkan **persistent volume** dengan mount path `/data` sebelum mengimpor data. Storage container biasa bersifat sementara. Pastikan proses dapat menulis ke volume. Jangan mount ke `/app`, karena akan menutupi kode. Setelah layanan berjalan, unggah tujuh berkas media ke `/data/private-media` melalui endpoint pengelola HTTPS:

```sh
python3 deploy/upload_media.py https://DOMAIN-HELIPOD-ANDA private-media
```

Skrip meminta kunci pengelola tanpa menampilkannya di layar, lalu mengunggah hanya tujuh nama berkas yang diizinkan. Server memeriksa kunci, format, ukuran maksimal 30 MB, dan menyimpannya secara atomik di volume privat.

## 3. Domain dan Variables

Aktifkan domain HTTPS layanan dan arahkan target/internal port ke `8080`. Nama menu domain/volume dapat berbeda; dokumentasi publik Helipod belum merinci seluruh kolom UI.

| Variable | Nilai |
| --- | --- |
| PORT | 8080 |
| TEMU_ALLOWED_HOSTS | hostname publik persis, tanpa https://, path, atau slash |
| TEMU_SERVER_TOKEN | rahasia acak minimal 32 karakter |

Untuk beberapa hostname, pisahkan dengan koma tanpa spasi. Jangan memakai wildcard. Buat token sendiri di Terminal:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Simpan hasilnya di password manager dan variable rahasia Helipod. Jangan taruh di Git, chat, atau kirim kepada tamu. Token memberi akses pengelola seluruh instalasi. Setelah domain/variables/volume siap, deploy atau redeploy layanan. Jika domain baru tersedia setelah deploy pertama, isi hostname tersebut kemudian redeploy sebelum menggunakan aplikasi.

## 4. Hubungkan dan pindahkan data

Buka domain HTTPS → Pengaturan → masukkan kunci server yang sama. Pairing otomatis localhost sengaja tidak berlaku pada domain publik. Pastikan sinkronisasi tersambung.

Ekspor cadangan terenkripsi dari aplikasi lokal dan pulihkan di aplikasi domain baru melalui fitur pemulihan cadangan. Selesaikan antrean sinkronisasi sebelum mengganti acara. Periksa nama acara, tanggal, jumlah tamu, nomor, dan kode QR; jangan membuat ulang tamu yang sudah punya QR. Simpan salinan lokal sampai semua pemeriksaan selesai. Undangan digital memakai tautan publik `/invite`; QR masuk tetap dikelola per tamu.

Isi Pengaturan → Alamat undangan publik HTTPS dengan origin yang sama, misalnya `https://undangan.domain-anda.id`. Pastikan acara Cesar & Revalina, 21 November 2026, waktu akad/resepsi TBA, Steikhaus Bandung, serta link Maps yang diberikan sudah benar. Sinkronkan, lalu bagikan tautan publik `/invite` melalui daftar tamu. Kirim QR masuk per tamu lewat alur WhatsApp pengelola.

Perangkat petugas berikutnya: buka domain yang sama, masukkan kunci server, pilih **Buka acara saya dari server** dan acara yang sudah dimigrasikan.

Instalasi ini hanya menerima satu acara aktif. Dari perangkat baru, isi kunci lalu pilih **Buka acara saya dari server** sebelum menekan Hubungkan; daftar tamu dan QR yang sudah ada akan diambil tanpa membuat acara kosong kedua.

Pengelola dapat menghapus tamu dari formulir Ubah. Jika tamu pernah check-in, nama, nomor, dan QR diganti dengan catatan anonim agar jumlah hadir tetap dapat diaudit. QR masuk tamu yang dihapus tidak lagi berlaku setelah sinkronisasi. Tombol **Hapus acara** di Pengaturan hanya tersedia saat server terhubung dan antrean perubahan kosong; tindakan ini menghapus acara, daftar tamu, akses lama, foto/video/musik, serta cadangan otomatis pada server. Buat cadangan terenkripsi yang ingin disimpan sebelum menghapus acara.

## 5. Pemeriksaan sebelum membagikan

- Buat tamu uji, sinkronkan, restart/redeploy, lalu pastikan data masih ada dari browser/perangkat lain.
- Buka `/invite` pada jendela privat tanpa kode: video, foto, dan musik tersedia, tanpa QR masuk atau daftar tamu.
- Pastikan tujuh berkas media sudah ada di `/data/private-media`; bila belum, undangan dapat dibuka tetapi foto/video/musik belum tampil.
- Uji kamera QR pada ponsel melalui HTTPS.
- Muat aplikasi petugas dan data, putuskan internet, check-in tamu uji, sambungkan lagi dan periksa sinkronisasi di perangkat kedua.
- Undangan publik membutuhkan internet saat dibuka; QR yang sudah diunduh bisa ditunjukkan offline. Dua perangkat offline tetap dapat menerima QR yang sama sampai tersambung dan konflik diperiksa.

Cadangan otomatis disimpan di `/data/backups` (48 snapshot). Cadangan ini berada di volume yang sama dengan database: simpan juga cadangan terenkripsi di tempat lain secara berkala. Aplikasi belum mengunggah cadangan ke layanan terpisah secara otomatis.

Server Python mandiri ini perlu berada di belakang HTTPS proxy Helipod. Konfigurasi Docker belum merupakan pengujian beban atau audit keamanan produksi. Uji alur nyata sebelum digunakan untuk acara.

## Jika gagal

- Build gagal: pastikan Dockerfile dan folder yang disebutkan berada pada root build yang sama.
- Layanan tidak hidup: periksa Logs, token minimal 32 karakter, kedua variable wajib terisi, dan izin volume `/data`.
- 502: cocokkan PORT dan target port 8080; proses harus bind 0.0.0.0 (skrip sudah mengaturnya).
- 403 saat akses API: cocokkan hostname TEMU_ALLOWED_HOSTS dengan domain browser; gunakan origin yang sama untuk aplikasi dan API.
- 401 saat sinkronisasi: periksa kunci di Pengaturan.
- Data hilang setelah redeploy: periksa volume persisten yang sama masih terpasang pada `/data`; jangan lanjut memasukkan tamu sebelum diperbaiki.

Referensi resmi: https://docs.helipod.io/quick-start dan https://docs.helipod.io/build-deploy/services

Panel RSVP membutuhkan koneksi ke server. Kunci tanda tangan tautan tamu, RSVP, dan doa disimpan dalam SQLite pada volume persisten serta ikut dalam cadangan server. Jangan mengganti database dengan database kosong setelah tautan dibagikan.
