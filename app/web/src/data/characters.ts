/*
 * The six official characters. Order is fixed by
 * the versioned character data below and must not
 * change; the art is the web-sized WebP rendering of the six official PNGs.
 *
 * Spec §4.3: all four languages state the same facts. A translation may not
 * change a political archetype, a garment colour or a fixed prop.
 */
import type { Locale } from "../i18n";

import koishi from "../assets/characters/01-koishi-komeiji.webp";
import marisa from "../assets/characters/02-marisa-kirisame.webp";
import reimu from "../assets/characters/03-reimu-hakurei.webp";
import flandre from "../assets/characters/04-flandre-scarlet.webp";
import reisen from "../assets/characters/05-reisen-udongein-inaba.webp";
import cirno from "../assets/characters/06-cirno.webp";

export interface CharacterCopy {
  /** Display name in this locale. */
  name: string;
  /** Year and age. */
  grade: string;
  /** US political archetype — identical claim in all four languages. */
  archetype: string;
  /** One-line personality. */
  personality: string;
  /** Fixed costume, colours and props. */
  props: string;
  /** Approved English voice character, described in this locale. */
  voice?: string;
  /** Comedic function in the satire. */
  fn: string;
}

export interface Character {
  /** Stable identity within Inland Empire High. */
  key: string;
  slot: string;
  /** Romanised name, shown under the localized name in every locale. */
  nameEn: string;
  image: string;
  copy: Record<Locale, CharacterCopy>;
}

export const CHARACTERS: Character[] = [
  {
    slot: "S1",
    key: "koishi",
    nameEn: "KOISHI KOMEIJI",
    image: koishi,
    copy: {
      "zh-CN": {
        voice: "幼女感的高音，轻柔、空灵、梦幻；英语表达柔和，略显心不在焉。",
        name: "古明地恋",
        grade: "十一年级 · 16 岁",
        archetype: "反建制独立派",
        personality:
          "没有稳定立场，也不承认参加了任何组织；却总能无意识说出全场最诚实、最具破坏力的一句话。",
        props: "黑帽 · 黄针织衫 · 蓝色心形导线",
        fn: "决定选举结果的摇摆选民——但她不知道今天有投票。",
      },
      en: {
        voice: "very young-sounding, airy, dreamy, high-pitched little-girl voice; soft, distracted English delivery",
        name: "Koishi Komeiji",
        grade: "11th grade · 16",
        archetype: "ANTI-ESTABLISHMENT INDEPENDENT",
        personality:
          "Holds no stable position and denies belonging to anything; still says the single most honest and most destructive line in the room, without noticing.",
        props: "Black hat · yellow knit sweater · blue heart-shaped wire",
        fn: "The swing voter who decides the election — except she does not know there is one today.",
      },
      ja: {
        voice: "幼い少女らしい高い声。柔らかく夢見がちで、少し上の空の英語。",
        name: "古明地こいし",
        grade: "11 年生 · 16 歳",
        archetype: "反体制無所属",
        personality:
          "定まった立場を持たず、どの組織にも属していないと言い張る。それでいて、その場でいちばん正直でいちばん破壊的な一言を無自覚に口にする。",
        props: "黒い帽子 · 黄色のニット · 青いハート形のコード",
        fn: "選挙結果を決める浮動票。ただし本人は今日が投票日だと知らない。",
      },
      es: {
        voice: "Voz de niña pequeña, aguda, suave, etérea y soñadora; inglés distraído y delicado.",
        name: "Koishi Komeiji",
        grade: "11.º curso · 16 años",
        archetype: "INDEPENDIENTE ANTISISTEMA",
        personality:
          "No tiene una postura estable y niega pertenecer a nada; aun así suelta, sin darse cuenta, la frase más sincera y más destructiva de la sala.",
        props: "Sombrero negro · jersey de punto amarillo · cable azul con forma de corazón",
        fn: "El voto indeciso que decide las elecciones, salvo que ella no sabe que hoy se vota.",
      },
    },
  },
  {
    slot: "S2",
    key: "marisa",
    nameEn: "MARISA KIRISAME",
    image: marisa,
    copy: {
      "zh-CN": {
        voice: "充满活力的少女声，略带沙哑；英语表达快速、自信。",
        name: "雾雨魔理沙",
        grade: "十二年级 · 17 岁",
        archetype: "自由意志主义独立派",
        personality:
          "把借用、破解、走私和剽窃统称为“无许可创新”；相信公共资源都该先改造成订阅服务。",
        props: "巨大女巫帽 · 白围裙 · 扫帚",
        fn: "每逢公共危机，午休前造出有效但收费的解决方案。",
      },
      en: {
        voice: "energetic youthful teenage-girl voice with a light rasp; quick, confident English delivery",
        name: "Marisa Kirisame",
        grade: "12th grade · 17",
        archetype: "LIBERTARIAN INDEPENDENT",
        personality:
          "Files borrowing, cracking, smuggling and outright plagiarism under “permissionless innovation”; believes every public resource should be converted into a subscription first.",
        props: "Huge witch hat · white apron · broom",
        fn: "Ships a working, billable fix for every public crisis before lunch is over.",
      },
      ja: {
        voice: "活発な少女の声に軽いかすれ。速く自信のある英語。",
        name: "霧雨魔理沙",
        grade: "12 年生 · 17 歳",
        archetype: "リバタリアン無所属",
        personality:
          "借用も解析も密輸も盗用も、まとめて「許可不要のイノベーション」と呼ぶ。公共の資源はまずサブスクに作り替えるべきだと信じている。",
        props: "巨大な魔女帽 · 白いエプロン · 箒",
        fn: "公共の危機が起きるたび、昼休みが終わる前に有効かつ有料の解決策を作り上げる。",
      },
      es: {
        voice: "Voz adolescente enérgica, ligeramente ronca; inglés rápido y seguro.",
        name: "Marisa Kirisame",
        grade: "12.º curso · 17 años",
        archetype: "INDEPENDIENTE LIBERTARIA",
        personality:
          "Agrupa el préstamo, el crackeo, el contrabando y el plagio bajo «innovación sin permisos»; cree que todo recurso público debería convertirse antes en una suscripción.",
        props: "Sombrero de bruja enorme · delantal blanco · escoba",
        fn: "Ante cada crisis pública entrega, antes de que acabe la comida, una solución que funciona y se cobra.",
      },
    },
  },
  {
    slot: "S3",
    key: "reimu",
    nameEn: "REIMU HAKUREI",
    image: reimu,
    copy: {
      "zh-CN": {
        voice: "音调略低但不成人化的少女声；英语表达干练、克制、一本正经。",
        name: "博丽灵梦",
        grade: "十二年级 · 17 岁",
        archetype: "务实中间派",
        personality:
          "不相信任何意识形态，只相信流程、捐款箱和“维持秩序费”；她的妥协让所有人都更生气，但表格很平衡。",
        props: "巨大红蝴蝶结 · 无标签灰色布基胶带",
        fn: "学生会主席，每场灾难的收费窗口。",
      },
      en: {
        voice: "young teenage-girl voice, slightly lower but never adult; dry, controlled, deadpan English delivery",
        name: "Reimu Hakurei",
        grade: "12th grade · 17",
        archetype: "PRAGMATIC CENTRIST",
        personality:
          "Believes in no ideology, only in process, the donation box and an “order maintenance fee”; her compromises leave everyone angrier, but the spreadsheet balances.",
        props: "Huge red bow · roll of unbranded grey duct tape",
        fn: "Student council president, and the payment window at every disaster.",
      },
      ja: {
        voice: "少し低めでも大人びない少女の声。淡々と抑制された英語。",
        name: "博麗霊夢",
        grade: "12 年生 · 17 歳",
        archetype: "現実路線の中道",
        personality:
          "どのイデオロギーも信じず、手続きと賽銭箱と「秩序維持費」だけを信じている。彼女の妥協は全員をさらに怒らせるが、収支表はきれいに釣り合う。",
        props: "巨大な赤いリボン · 無地の灰色ダクトテープ",
        fn: "生徒会長にして、あらゆる災害の料金窓口。",
      },
      es: {
        voice: "Voz adolescente algo más grave, sin sonar adulta; inglés seco, controlado e impasible.",
        name: "Reimu Hakurei",
        grade: "12.º curso · 17 años",
        archetype: "CENTRISTA PRAGMÁTICA",
        personality:
          "No cree en ninguna ideología, solo en el procedimiento, la caja de donativos y una «tasa de mantenimiento del orden»; sus acuerdos dejan a todos más enfadados, pero la hoja de cálculo cuadra.",
        props: "Lazo rojo enorme · rollo de cinta americana gris sin marca",
        fn: "Presidenta del consejo estudiantil y ventanilla de cobro de cada catástrofe.",
      },
    },
  },
  {
    slot: "S4",
    key: "flandre",
    nameEn: "FLANDRE SCARLET",
    image: flandre,
    copy: {
      "zh-CN": {
        voice: "明亮、顽皮的幼女高音；英语表达情绪跳跃，带着兴奋与喜悦。",
        name: "芙兰朵露·斯卡蕾特",
        grade: "十年级 · 16 岁",
        archetype: "反建制民粹派",
        personality:
          "把“推倒一切”当成短视频内容赛道；不关心新制度是什么，只关心旧制度倒下时直播间人数涨没涨。",
        props: "七彩水晶翼架 · 红缎带软帽 · 手机",
        fn: "把任何安静的公共会议变成有赞助商的骚乱直播。",
      },
      en: {
        voice: "high-pitched, bright, impish little-girl voice; volatile, delighted English delivery",
        name: "Flandre Scarlet",
        grade: "10th grade · 16",
        archetype: "ANTI-ESTABLISHMENT POPULIST",
        personality:
          "Treats “tear it all down” as a short-video content niche; does not care what replaces the old system, only whether the viewer count went up while it fell.",
        props: "Seven-colour crystal wing frame · white cap with red ribbon · phone",
        fn: "Turns any quiet public meeting into a sponsored riot livestream.",
      },
      ja: {
        voice: "明るくいたずらっぽい幼い少女の高い声。喜びに満ち、感情の変化が大きい英語。",
        name: "フランドール・スカーレット",
        grade: "10 年生 · 16 歳",
        archetype: "反体制ポピュリスト",
        personality:
          "「全部ぶっ壊す」をショート動画のジャンルとして扱う。新しい制度が何かには関心がなく、古い制度が倒れる瞬間に同時接続数が伸びたかどうかだけを見ている。",
        props: "七色の水晶の翼 · 赤いリボンの白い帽子 · スマートフォン",
        fn: "静かな公開会議を、スポンサー付きの暴動配信に変えてしまう。",
      },
      es: {
        voice: "Voz de niña pequeña, aguda, brillante y traviesa; inglés voluble y entusiasmado.",
        name: "Flandre Scarlet",
        grade: "10.º curso · 16 años",
        archetype: "POPULISTA ANTISISTEMA",
        personality:
          "Trata el «que caiga todo» como un nicho de vídeo corto; no le importa qué sustituye al sistema viejo, solo si subieron los espectadores mientras caía.",
        props: "Armazón de alas de cristal de siete colores · gorro blanco con cinta roja · móvil",
        fn: "Convierte cualquier reunión pública tranquila en un directo de disturbios con patrocinador.",
      },
    },
  },
  {
    slot: "S5",
    key: "reisen",
    nameEn: "REISEN U. INABA",
    image: reisen,
    copy: {
      "zh-CN": {
        voice: "清晰的少女声；英语表达精确、真诚，像学生记者，不用成熟权威的成人声线。",
        name: "铃仙·优昙华院·因幡",
        grade: "十二年级 · 17 岁",
        archetype: "反战进步派",
        personality:
          "前 JROTC 学员，对监控、警务和战争宣传极度敏感；能把一次饮水机故障写成八十四页公民权报告。",
        props: "高兔耳 · 采访话筒 · 夹板",
        fn: "唯一发现真正问题的人，但解释长到所有人换台。",
      },
      en: {
        voice: "clear youthful teenage-girl voice; precise, earnest student-reporter English delivery, never mature or authoritative-adult",
        name: "Reisen Udongein Inaba",
        grade: "12th grade · 17",
        archetype: "ANTI-WAR PROGRESSIVE",
        personality:
          "A former JROTC cadet, acutely sensitive to surveillance, policing and war propaganda; can turn one broken water fountain into an eighty-four-page civil rights report.",
        props: "Tall rabbit ears · interview microphone · clipboard",
        fn: "The only one who spots the real problem, explained at a length that makes everyone change the channel.",
      },
      ja: {
        voice: "明瞭な少女の声。学生記者らしく正確で誠実な英語。成熟した権威的な声にはしない。",
        name: "鈴仙・優曇華院・イナバ",
        grade: "12 年生 · 17 歳",
        archetype: "反戦リベラル",
        personality:
          "元 JROTC 生。監視、警察、戦争プロパガンダに極度に敏感で、給水器の故障ひとつを 84 ページの公民権レポートに仕立て上げる。",
        props: "長いウサギの耳 · 取材用マイク · クリップボード",
        fn: "本当の問題に気づく唯一の人物。ただし説明が長すぎて全員がチャンネルを変える。",
      },
      es: {
        voice: "Voz adolescente clara; inglés preciso y sincero de reportera escolar, sin autoridad adulta.",
        name: "Reisen Udongein Inaba",
        grade: "12.º curso · 17 años",
        archetype: "PROGRESISTA ANTIBELICISTA",
        personality:
          "Excadete del JROTC, hipersensible a la vigilancia, la policía y la propaganda de guerra; capaz de convertir una fuente de agua averiada en un informe de derechos civiles de ochenta y cuatro páginas.",
        props: "Orejas de conejo largas · micrófono de entrevista · portapapeles",
        fn: "La única que detecta el problema de verdad, con una explicación tan larga que todos cambian de canal.",
      },
    },
  },
  {
    slot: "S6",
    key: "cirno",
    nameEn: "CIRNO",
    image: cirno,
    copy: {
      "zh-CN": {
        voice: "响亮、明快、孩子气的少女声；英语表达自夸、急促，像一口气说完。",
        name: "琪露诺",
        grade: "十年级 · 16 岁",
        archetype: "右翼民粹派",
        personality:
          "坚信复杂问题是弱者发明的借口，竞选纲领永远只有“我最强”；不理解保守主义，却极其理解口号、敌人和扩音器。",
        props: "六片冰晶翼 · 蓝白棒球连帽服 · 无字扩音器",
        fn: "能把一次天气预报变成文化战争。",
      },
      en: {
        voice: "loud, bright, childish little-girl voice; boastful, breathless English delivery",
        name: "Cirno",
        grade: "10th grade · 16",
        archetype: "RIGHT-WING POPULIST",
        personality:
          "Certain that complicated problems are an excuse invented by the weak; her entire platform is “I am the strongest”. She does not understand conservatism, but she understands slogans, enemies and a megaphone perfectly.",
        props: "Six ice-crystal wings · blue and white varsity hoodie · unlabelled megaphone",
        fn: "Can turn a weather forecast into a culture war.",
      },
      ja: {
        voice: "大きく明るい子どもらしい少女の声。自慢げで息せき切った英語。",
        name: "チルノ",
        grade: "10 年生 · 16 歳",
        archetype: "右派ポピュリスト",
        personality:
          "複雑な問題は弱い人間が考え出した言い訳だと信じきっており、公約は常に「あたいが最強」だけ。保守思想は理解していないが、スローガンと敵とメガホンのことは完璧に理解している。",
        props: "6 枚の氷晶の翼 · 青と白のスタジャンパーカー · 無地のメガホン",
        fn: "天気予報ひとつを文化戦争に変えられる。",
      },
      es: {
        voice: "Voz infantil fuerte y alegre; inglés fanfarrón, rápido y sin aliento.",
        name: "Cirno",
        grade: "10.º curso · 16 años",
        archetype: "POPULISTA DE DERECHAS",
        personality:
          "Convencida de que los problemas complicados son una excusa inventada por los débiles; su programa entero es «soy la más fuerte». No entiende el conservadurismo, pero entiende a la perfección los eslóganes, los enemigos y un megáfono.",
        props: "Seis alas de cristal de hielo · sudadera universitaria azul y blanca · megáfono sin rótulo",
        fn: "Capaz de convertir una previsión del tiempo en una guerra cultural.",
      },
    },
  },
];
