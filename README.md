# Flappy Bat / 박쥐의 야간비행

Three.js와 순수 JavaScript로 만든, 빌드 과정이 필요 없는 GitHub Pages용 3D 플래피 게임입니다. 모든 동굴, 바위, 박쥐, 파티클은 런타임에 절차적으로 생성됩니다.

## 실행

브라우저에서 `docs/index.html`을 직접 열 수도 있지만, CDN과 모듈/보안 정책이 다른 브라우저에서는 로컬 서버를 권장합니다.

```bash
python3 -m http.server 8000
```

그 다음 `http://localhost:8000/docs/`를 엽니다.

## 조작

- 클릭 / 탭 / `Space`: 박쥐 날갯짓
- 충돌하면 자동으로 게임 오버가 되며 `다시 시작` 버튼으로 재시작
- 점수와 최고 점수는 브라우저 `localStorage`에 저장됩니다.

## GitHub Pages 배포

저장소의 **Settings → Pages**에서 Source를 **Deploy from a branch**, Branch를 `main`, Folder를 `/docs`로 선택하면 됩니다. 저장 후 Pages가 제공하는 주소에서 바로 플레이할 수 있습니다.

외부 에셋은 사용하지 않으며, Three.js만 CDN에서 불러옵니다.
