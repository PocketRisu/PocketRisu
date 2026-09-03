<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# Hướng dẫn di chuyển từ RisuAI

> 🌐 Hướng dẫn này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng tham khảo phiên bản [tiếng Anh](../en/migration.md) hoặc [tiếng Hàn](../ko/migration.md).

Có ba cách để di chuyển dữ liệu từ cài đặt RisuAI hiện có (RisuAI Web, RisuAI Cục bộ) sang PocketRisu. Chọn dựa trên môi trường nguồn và kích thước dữ liệu của bạn.

- [1. Tệp sao lưu cục bộ (.bin)](#1-tệp-sao-lưu-cục-bộ-bin) — Hoạt động trong mọi môi trường. Phương pháp phổ biến nhất.
- [2. Tải lên zip thư mục save](#2-tải-lên-zip-thư-mục-save) — RisuAI Cục bộ, dữ liệu nhỏ.
- [3. Sao chép trực tiếp thư mục save](#3-sao-chép-trực-tiếp-thư-mục-save) — RisuAI Cục bộ, dữ liệu lớn.


## Trước khi bắt đầu

> ⚠️ **Sao lưu dữ liệu hiện có** trước khi di chuyển. Bạn có thể xuất tệp `.bin` từ Cài đặt > Sao lưu của RisuAI.


---

## 1. Tệp sao lưu cục bộ (.bin)

Xuất tệp sao lưu `.bin` từ RisuAI hiện có, sau đó nhập vào PocketRisu. Hoạt động bất kể môi trường nguồn (web / Tauri / Capacitor / cục bộ).

1. **Trong RisuAI hiện có**: Cài đặt > Sao lưu > "Lưu bản sao lưu cục bộ" để xuất tệp `.bin`.
2. **Trong PocketRisu**: Cài đặt > Di chuyển dữ liệu > "Nhập bản sao lưu cục bộ Risu gốc" để nhập tệp `.bin`.

> ⚠️ **Nếu bạn dùng RisuAI web khi đã đăng nhập tài khoản** (dữ liệu được đồng bộ lên máy chủ RisuAI), tệp tạo bằng "Lưu bản sao lưu cục bộ" có cơ sở dữ liệu đã mã hóa nên PocketRisu không đọc được. Việc nhập sẽ bị từ chối kèm giải thích. Hãy xuất theo một trong hai cách sau:
> - **Đăng xuất rồi sao lưu** (khuyến nghị): Cài đặt > Tài khoản > Đăng xuất sẽ chuyển dữ liệu về trình duyệt (thiết bị). Sau đó "Lưu bản sao lưu cục bộ" sẽ tạo bản sao lưu bình thường, bao gồm cả tài nguyên.
> - **Sao lưu một phần**: dùng được khi đang đăng nhập và không mã hóa, nhưng chỉ gồm ảnh đại diện của nhân vật.



---

## 2. Tải lên zip thư mục save

Nếu bạn đang sử dụng RisuAI Cục bộ (phiên bản máy chủ Node), bạn có thể nén thư mục `save` và tải lên.

1. Nén thư mục `save` của dự án RisuAI hiện có thành tệp zip.
2. Trong PocketRisu, vào Cài đặt > Di chuyển dữ liệu > accordion "Nhập thư mục save từ NodeOnly Risu".
3. Tải lên zip qua "Nhập từ thư mục save (Tải lên Zip)".

> Nếu tệp zip quá lớn, việc tải lên có thể thất bại. Trong trường hợp đó, hãy sử dụng [3. Sao chép trực tiếp thư mục save](#3-sao-chép-trực-tiếp-thư-mục-save).


---

## 3. Sao chép trực tiếp thư mục save

Phù hợp cho dữ liệu lớn (vài GB trở lên). Yêu cầu quyền truy cập trực tiếp hệ thống tệp của máy chủ.

1. Dừng máy chủ PocketRisu.
2. Ghi đè thư mục `save` của PocketRisu bằng thư mục `save` của RisuAI hiện có.
3. Khởi động lại máy chủ PocketRisu — quá trình di chuyển tự động bắt đầu.
    - Theo dõi tiến trình trong terminal hoặc nhật ký PM2.
4. Sau khi hoàn tất di chuyển, sử dụng Cài đặt > Di chuyển dữ liệu > accordion "Nhập thư mục save từ NodeOnly Risu" > "Dọn dẹp tệp save đã di chuyển" để xóa các tệp gốc và thu hồi dung lượng đĩa.


---

## Tôi nên chọn phương pháp nào?

| Tình huống                                                | Phương pháp được đề xuất             |
| --------------------------------------------------------- | ------------------------------------ |
| Di chuyển từ RisuAI Web                                   | 1. Sao lưu `.bin`                    |
| Di chuyển từ RisuAI Cục bộ, dữ liệu nhỏ                   | 2. Tải lên Zip                       |
| Di chuyển từ RisuAI Cục bộ, dữ liệu lớn (10GB+)           | 3. Sao chép trực tiếp thư mục save   |
| Không chắc                                                | 1. Sao lưu `.bin`                    |


---

← [Quay lại README](../../i18n/README.vi.md)
