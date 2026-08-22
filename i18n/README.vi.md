<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu — Nền tảng Trò chuyện Nhập vai AI Tự lưu trữ" width="900" />
</p>

<h1 align="center">PocketRisu — Trò chuyện Nhập vai AI Tự lưu trữ</h1>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/PocketRisu/PocketRisu/releases">
    <img alt="Latest Release" src="https://img.shields.io/github/v/release/PocketRisu/PocketRisu?label=latest" />
  </a>
  <a href="../LICENSE">
    <img alt="License: GPL-3.0" src="https://img.shields.io/github/license/PocketRisu/PocketRisu" />
  </a>
  <a href="https://nodejs.org/">
    <img alt="Node" src="https://img.shields.io/badge/node-≥22.12-brightgreen" />
  </a>
</p>

> 🌐 README này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng tham khảo phiên bản [tiếng Anh](../README.md) hoặc [tiếng Hàn](README.ko.md). Hoan nghênh đóng góp.

PocketRisu là một nền tảng trò chuyện nhập vai AI tự lưu trữ, chạy trên PC hoặc máy chủ cá nhân của bạn và truy cập từ PC, máy tính bảng và điện thoại thông minh qua trình duyệt web.

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="../assets/screenshots/screenshot-pc-chat.png" alt="Trò chuyện trên PC" height="420" /></td>
      <td align="center"><img src="../assets/screenshots/screenshot-mobile-chat.png" alt="Trò chuyện trên di động" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>Di động</b></td>
    </tr>
  </table>
</p>


## Tài liệu

- [Hướng dẫn cài đặt](../docs/vi/install.md)
- [Hướng dẫn di chuyển từ RisuAI](../docs/vi/migration.md)
- [Truy cập từ xa](../docs/vi/remote.md)
- [Hướng dẫn cài đặt Termux (Android)](../docs/vi/termux.md)


## Tương thích với RisuAI

PocketRisu được phát triển từ [RisuAI](https://github.com/kwaroran/RisuAI), được tối ưu hóa cho môi trường tự lưu trữ. Dữ liệu RisuAI hiện có có thể được di chuyển toàn bộ, và tất cả tài sản trong hệ sinh thái RisuAI vẫn có thể sử dụng nguyên trạng.

- Tải xuống nhân vật RisuRealm
- Thẻ nhân vật (`.charx`, `.risum`, `.risup`, v.v.)
- Module, lorebook, preset
- Tệp sao lưu (`.bin`) tương thích hai chiều

Để di chuyển từ cài đặt RisuAI hiện có, xem [hướng dẫn di chuyển](../docs/vi/migration.md).


## Tính năng

- **Nhiều nhà cung cấp AI**: OpenAI, Claude, Gemini, DeepInfra, OpenRouter, Ollama và nhiều hơn
- **Truy cập đa thiết bị**: Chạy một máy chủ và truy cập từ PC, máy tính bảng, điện thoại thông minh qua trình duyệt web
- **Tạo phản hồi phía máy chủ**: Máy chủ tiếp tục tạo phản hồi ngay cả khi màn hình tắt hoặc mất kết nối — khi kết nối lại, phản hồi đã hoàn thành sẽ được khôi phục tự động
- **Lưu trữ dữ liệu thống nhất**: Tất cả dữ liệu (nhân vật, cuộc trò chuyện, cài đặt, ảnh inlay) được lưu trong một cơ sở dữ liệu SQLite duy nhất trên máy chủ của bạn (không phụ thuộc vào dịch vụ đám mây bên ngoài)
- **Sao lưu phía máy chủ tiện lợi**: Máy chủ xử lý sao lưu và khôi phục trực tiếp; cũng hỗ trợ xuất/nhập sao lưu cục bộ `.bin`
- **Bảng điều khiển mạnh mẽ**: Sử dụng đĩa (theo nhân vật / theo module), không gian snapshot có thể thu hồi, tối ưu hóa SQLite và nhiều hơn — tất cả trong một màn hình
- **Lorebook & bộ nhớ dài hạn**: World info / memory book, HypaMemoryV3 và các tính năng giữ ngữ cảnh khác
- **Dịch tự động**: Tự động dịch đầu vào và đầu ra để nhập vai đa ngôn ngữ
- **Script regex & plugin**: Sửa đổi đầu ra của mô hình và mở rộng chức năng
- **TTS & tài nguyên bổ sung**: Tổng hợp giọng nói, nhúng hình ảnh / âm thanh / video trong trò chuyện
- **Tự cập nhật**: Tự động phát hiện phiên bản; các bản phân phối portable cập nhật từ giao diện web
- **Truy cập từ xa di động**: Quick Tunnel (URL + QR) hoặc Tailscale
- **Giao diện đa ngôn ngữ**: Tiếng Hàn, tiếng Anh, tiếng Nhật, tiếng Trung và nhiều hơn


## Cộng đồng & Liên hệ

- Báo cáo lỗi / yêu cầu tính năng: [GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- Email: contact@pocketrisu.com


## Giấy phép

[GPL-3.0](../LICENSE)
