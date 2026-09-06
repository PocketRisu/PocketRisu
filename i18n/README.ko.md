<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu — 셀프호스팅 AI 롤플레이 채팅 플랫폼" width="900" />
</p>

<h1 align="center">PocketRisu — 셀프호스팅 AI 롤플레이 채팅</h1>

<p align="center">
  <a href="../README.md">English</a> | <strong>한국어</strong> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
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

PocketRisu는 PC나 개인 서버에 띄워두고, PC·태블릿·스마트폰 등 여러 기기에서 브라우저로 접속해 사용하는 나만의 AI 롤플레이 채팅 플랫폼입니다.

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="../assets/screenshots/screenshot-pc-chat.png" alt="PC 채팅" height="420" /></td>
      <td align="center"><img src="../assets/screenshots/screenshot-mobile-chat.png" alt="모바일 채팅" height="420" /></td>
    </tr>
    <tr>
      <td align="center"><b>PC</b></td>
      <td align="center"><b>모바일</b></td>
    </tr>
  </table>
</p>


## 문서

- [설치 가이드](../docs/ko/install.md)
- [RisuAI 데이터 이전 가이드](../docs/ko/migration.md)
- [원격 접속 가이드](../docs/ko/remote.md)
- [Termux 설치 가이드 (Android)](../docs/ko/termux.md)
- [플러그인 저장소 가이드](../docs/ko/plugin-storage.md)
- [캐릭터 비활성화 가이드](../docs/ko/deactivate-characters.md)


## RisuAI 호환

PocketRisu는 [RisuAI](https://github.com/kwaroran/RisuAI)에서 파생되어, 셀프호스팅 환경에 맞게 개선한 프로젝트입니다. 기존 RisuAI의 데이터를 통째로 마이그레이션할 수 있고, RisuAI 생태계의 모든 자산을 그대로 사용할 수 있습니다.

- RisuRealm 캐릭터 다운로드
- 캐릭터 카드 (`.charx`, `.risum`, `.risup` 등)
- 모듈, 로어북, 프리셋
- 백업 파일 (`.bin`) 양방향 호환

기존 RisuAI에서 이전하는 방법은 [데이터 이전 가이드](../docs/ko/migration.md)를 참고하세요.


## 주요 기능

- **다양한 AI 지원**: OpenAI, Claude, Gemini, DeepInfra, OpenRouter, Ollama 등 다양한 API 지원
- **다중 디바이스 접속**: 한 서버를 띄우고 PC·태블릿·스마트폰에서 브라우저로 접속
- **서버 사이드 생성**: 화면이 꺼지거나 연결이 끊겨도 서버가 생성을 계속하고, 다시 접속하면 완성된 응답이 자동 복구
- **데이터 통합 저장**: 캐릭터·채팅·설정·삽화 등 모든 데이터를 서버의 SQLite DB 하나에 보관 (외부 클라우드 의존 없음)
- **간편한 서버 백업**: 서버가 직접 백업/복원을 처리, 로컬 백업(.bin) 내보내기도 지원
- **강력한 대시보드**: 디스크 사용량(캐릭터별·모듈별), 스냅샷 회수 가능 용량, SQLite 정리 등을 한 화면에서 관리
- **로어북·장기 메모리**: 세계관/메모리 북, HypaMemoryV3 등 컨텍스트 유지 기능
- **자동 번역**: 입력/출력 자동 번역, 다양한 언어로 롤플레이 가능
- **정규식 스크립트·플러그인**: 출력 가공, 기능 확장
- **TTS·추가 에셋**: 음성 변환, 채팅 내 이미지·오디오·비디오 임베드
- **셀프 업데이트**: 새 버전 자동 감지, 포터블 배포는 웹 UI에서 업데이트
- **모바일 원격 접속**: Quick Tunnel(URL+QR), Tailscale 권장
- **다국어 UI**: 한국어, 영어, 일본어, 중국어 등


## 커뮤니티 & 연락처

- 버그 리포트 / 기능 제안: [GitHub Issues](https://github.com/PocketRisu/PocketRisu/issues)
- 이메일: contact@pocketrisu.com
- 후원: [Patreon](https://patreon.com/PocketRisu/membership) — 전적으로 자유이며, 후원자 이름 게시 외에 추가 기능이나 혜택은 없습니다


## 라이선스

[GPL-3.0](../LICENSE)
