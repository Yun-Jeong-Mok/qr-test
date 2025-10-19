// server.js

// 1. 라이브러리 및 설정
const express = require('express')
const qrcode = require('qrcode')
const axios = require('axios')
const { SolapiMessageService } = require('solapi')
const { v4: uuidv4 } = require('uuid') // 고유 토큰 생성을 위한 uuid
require('dotenv').config() // .env 파일 사용 설정

const app = express()
const port = 3000

const API_BASE_URL = "https://accesscontrolserver.onrender.com"
const PUBLIC_HOST = process.env.PUBLIC_HOST || `http://localhost:${port}`;

// coolsms API 설정
const messageService = new SolapiMessageService(
  process.env.API_KEY,
  process.env.API_SECRET
)

// body-parser 설정 (폼 데이터 처리를 위함)
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// EJS 템플릿 엔진 설정
app.set('view engine', 'ejs')

// 데이터베이스를 대신할 임시 저장소 (메모리 기반)
// 실제 프로젝트에서는 이 부분을 DB 담당 팀원이 구현한 DB 로직으로 대체해야 합니다.
const qrTokenStore = {}

// 2. 라우트(경로) 설정

// 기본 테스트 페이지 (index.ejs) 렌더링
app.get('/', (req, res) => {
  res.render('index')
})

/**
 * 기능 1 & 3 & 4: QR 생성, SMS 전송 API 연동
 * - 고유 토큰 생성
 * - 토큰을 담은 인증 URL 생성
 * - URL로 QR 코드 이미지(Data URL) 생성
 * - 입력된 전화번호로 인증 URL을 SMS로 전송
 */
app.post('/generate-qr', async (req, res) => {
  let { phoneNumber, validTime } = req.body // 테스트 페이지에서 전화번호와 유효시간 받기

  if (!phoneNumber || !validTime) {
    return res.status(400).send('전화번호와 유효시간을 모두 입력해주세요.')
  }

  phoneNumber = phoneNumber.replace(/-/g, '');

  try {
    // 1. 일회용 고유 토큰 생성
    const token = uuidv4()
    const expiresAt = Date.now() + parseInt(validTime) * 60 * 1000 // 유효시간(분)을 밀리초로 변환하여 만료 시간 설정
    const purpose = "Visitor"; 
    const device_id = "device";
    const status = "대기 중";
    // 2. (DB 대체) 생성된 토큰과 만료 시간, 전화번호를 임시 저장소에 저장
    qrTokenStore[token] = { phoneNumber, expiresAt, isValid: true, purpose, device_id, status }
    console.log('생성된 QR 토큰:', qrTokenStore[token])

    // 3. QR 코드로 만들 인증 URL (서버의 인증 엔드포인트)
    const authUrl = `${PUBLIC_HOST}/verify-qr?token=${token}`
    console.log(`생성된 인증 URL: ${authUrl}`);


    // 4. QR 코드 이미지 생성 (PNG 데이터 URL 형식)
    const qrImageDataUrl = await qrcode.toDataURL(authUrl)

    // 5. SMS 전송 API 호출
    const message = `[출입 인증] 아래 링크를 통해 QR 코드를 인증해주세요.\n\n${authUrl}`
    await messageService.sendOne({
      to: phoneNumber,
      from: process.env.SENDER_NO,
      text: message,
    })

    // 6. 결과 페이지로 QR 코드 이미지와 함께 렌더링
    res.render('result', { qrImage: qrImageDataUrl, phone: phoneNumber })
  } catch (error) {
    if (axios.isAxiosError(error)) {
        console.error('⚠️ 외부 API 호출 실패 (AXIOS):', error.response?.status, error.message, error.response?.data);
        return res.status(500).send(`서버 오류: ${error.message} (상세: ${error.response?.data || '응답 없음'})`);
    }
    console.error('QR 생성 또는 SMS 전송 실패:', error)
    res.status(500).send('서버 오류가 발생했습니다.')
  }
})

/**
 * 기능 2: QR 인증
 * - QR 스캔 시 접속될 엔드포인트
 * - URL의 token 파라미터를 받아 유효성 검증
 */
app.get('/verify-qr', async (req, res) => {
  const { token } = req.query
  

  if (!token) {
    return res.status(400).send('인증 토큰이 없습니다.')
  }

  // (DB 대체) 임시 저장소에서 토큰 정보 조회
  const tokenData = qrTokenStore[token]

  // 토큰 유효성 검증 로직
  if (!tokenData) {
    return res.status(404).send('유효하지 않은 QR 코드입니다.')
  }
  if (Date.now() > tokenData.expiresAt) {
    tokenData.isValid = false;
    tokenData.status = "만료됨";
    return res.status(410).send('만료된 QR 코드입니다.')
  }
  if (!tokenData.isValid) {
    return res.status(409).send('이미 사용된 QR 코드입니다.')
  }
  if (tokenData.status !== "대기 중") {
    return res.status(409).send(`이미 사용된 QR 코드입니다 (상태: ${tokenData.status}).`);
  }
  

  const currentTimestamp = new Date().toISOString();
  const getApiUrl = `${API_BASE_URL}/qr-events`;

        try {
            const response = await axios.get(getApiUrl);
            const events = response.data.qr_events || response.data;
            const currentDbLength = Array.isArray(events) ? events.length : 0;
            console.log(`✅ 외부 DB 목록 길이 확인: ${currentDbLength}.`);
        } catch (getError) {
            console.error('⚠️ 외부 DB 목록 GET 실패 (ID 계산 불가):', getError.message);
            // GET 요청 실패 시, ID를 결정할 수 없으므로 에러를 던져 POST를 막습니다.
            throw new Error(`외부 DB 목록을 가져오지 못해 새 ID를 결정할 수 없습니다: ${getError.message}`);
        }
      

  // 인증 성공 응답 (실제 시스템에서는 출입문 개방 신호 등을 보냄)
  const postApiUrl = `${API_BASE_URL}/qr-events`;

  const externalEventPayload = {
    "client": {
        "device_id": tokenData.device_id,
    },
    "data": {
        "phone": tokenData.phoneNumber,
        "purpose": tokenData.purpose,
        "requested_at": currentTimestamp,
        "status": tokenData.status
    }
  }

  await axios.post(postApiUrl, externalEventPayload);
  console.log(`✅ 외부 API에 인증 성공 로그 POST 완료. Payload:`, externalEventPayload);

  tokenData.isValid = false
  tokenData.status = "인증 성공"
  
  res.send(
    `<h1>✅ 인증 성공</h1><p>환영합니다, ${tokenData.phoneNumber}님!</p><p>출입문이 열립니다.</p>`
  )
})

// 3. 서버 실행
app.listen(port, () => {
  console.log(`서버가 ${PUBLIC_HOST} 에서 실행 중입니다.`)
})
