#!/usr/bin/env node
// Replace the "What is DeepThink" intro section in every README*.md
// with the new positioning content, translated per language.
//
// Section boundaries: first `## ` heading (What is DeepThink) and the
// first `### ` subsection after it (Key Features). The content between
// (exclusive of both headings) is replaced with the translated block.

const fs = require('fs');
const path = require('path');

// English terms kept verbatim across all translations: AI Coding, Self-Evolving,
// Full-Stack Observability, Bug Auto-Fix Loop, Human-Agent Symbiosis, Harness
// Engineering, Loop Engineering, AI Infra, AGI, SaaS, LDAP.
// Channel list (飞书/钉钉/企微) → Feishu/DingTalk/WeCom in non-Chinese locales.

const translations = {
  'README.md': `DeepThink, an enterprise-grade autonomous Agent self-evolving superintelligence platform, is a pioneer in the transition from Harness Engineering to the Loop Engineering paradigm and a new generation of AI Infrastructure (AI Infra) for enterprise customers. The DeepThink platform centers on a multi-Agent collaboration framework, fusing AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, and Human-Agent Symbiosis to build an enterprise-grade AI system that continuously learns, self-improves, and ultimately grows into a superintelligence:

- **AI Autonomous R&D Platform** — Agents independently complete the full software development lifecycle, eliminating the need for human engineers on routine coding tasks
- **Self-Evolving Agent Engine** — Agents continuously learn from errors, absorb knowledge from the codebase, and evolve from user feedback
- **Programmer-Agent Collaboration Hub** — Every programmer owns a personal "Development Project" containing multiple parallel sessions, with a central scheduler preventing concurrency conflicts
- **Enterprise SaaS Platform** — Multi-tenant isolation, tiered permissions, elastic billing, and enterprise integrations (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligence Incubator** — Through continuous evolution, a single Agent ultimately attains the comprehensive capabilities of a full software team

> "Let every enterprise own a never-stopping, continuously evolving AI super R&D team — from tool user, to code creator, ultimately growing into a self-replicating superintelligence. Let us walk together on the road to AGI."`,

  'README.zh-CN.md': `DeepThink, 企业级自主 Agent 超级智能体自进化平台，从 Harness Engineering 到 Loop Engineering 范式的先行者，是面向企业客户的新一代 AI 基础设施(AI Infra)。DeepThink 平台以多 Agent 协作框架为核心，融合 AI 自主编程（AI Coding）、自主进化（Self-Evolving）、全栈可观测性（Full-Stack Observability）、Bug 自修复闭环（Bug Auto-Fix Loop） 与 程序员-Agent 共生协作（Human-Agent Symbiosis），构建一个能持续学习、自我改进、最终成长为超级智能体的企业级 AI 系统：

- **AI 自主研发平台** —— Agent 独立完成软件研发全生命周期，无需人类工程师介入常规编码任务
- **自进化智能体引擎** —— Agent 持续从错误中学习、从代码库中吸收知识、从用户反馈中进化
- **程序员-Agent 协作中枢** —— 每位程序员拥有个人"开发项目"，内含多个并行会话，中央调度防止并发冲突
- **企业级 SaaS 平台** —— 多租户隔离、权限分级、计费弹性、企业集成（飞书/钉钉/企微/LDAP）
- **超级智能体孵化器** —— 通过持续进化，单一 Agent 最终具备完整软件团队综合能力

> "让每一家企业都拥有一支永不停歇、持续进化的 AI 超级研发团队——从工具使用者，到代码创造者，最终成长为可自我繁衍的超级智能体。让我们在通往 AGI 的道路上一起前行。"`,

  'README.es.md': `DeepThink, una plataforma de auto-evolución de superinteligencia Agent autónoma de nivel empresarial, pionera en la transición del paradigma Harness Engineering al Loop Engineering, es la nueva generación de Infraestructura de IA (AI Infra) para clientes empresariales. La plataforma DeepThink se centra en un marco de colaboración multi-Agent, fusionando AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop y Human-Agent Symbiosis para construir un sistema de IA empresarial que aprende continuamente, se auto-mejora y, en última instancia, crece hasta convertirse en una superinteligencia:

- **Plataforma de I+D Autónoma con IA** — Los Agent completan de forma independiente el ciclo de vida completo del desarrollo de software, sin necesidad de ingenieros humanos en tareas de codificación rutinarias
- **Motor de Agent Auto-Evolutivo** — Los Agent aprenden continuamente de los errores, absorben conocimiento del código base y evolucionan a partir de los comentarios de los usuarios
- **Centro de Colaboración Programador-Agent** — Cada programador posee un "Proyecto de Desarrollo" personal con múltiples sesiones paralelas, y un planificador central evita conflictos de concurrencia
- **Plataforma SaaS Empresarial** — Aislamiento multi-tenant, permisos por niveles, facturación elástica e integraciones empresariales (Feishu/DingTalk/WeCom/LDAP)
- **Incubadora de Superinteligencia** — Mediante evolución continua, un solo Agent alcanza finalmente las capacidades integrales de un equipo de software completo

> "Que cada empresa tenga un equipo de I+D súper de IA que nunca se detiene y evoluciona continuamente — del usuario de herramientas, al creador de código, creciendo finalmente hacia una superinteligencia auto-replicante. Caminemos juntos en el camino hacia AGI."`,

  'README.hi.md': `DeepThink, एक एंटरप्राइज़-ग्रेड स्वायत्त Agent सेल्फ-इवॉल्विंग सुपरइंटेलिजेंस प्लेटफ़ॉर्म, Harness Engineering से Loop Engineering प्रतिमान तक के संक्रमण का अग्रदूत, एंटरप्राइज़ ग्राहकों के लिए नई पीढ़ी का AI इंफ्रास्ट्रक्चर (AI Infra) है। DeepThink प्लेटफ़ॉर्म एक मल्टी-Agent सहयोग ढांचे के केंद्र में है, जो AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop और Human-Agent Symbiosis को जोड़ता है ताकि एक एंटरप्राइज़-ग्रेड AI सिस्टम बनाया जा सके जो लगातार सीखता है, स्वयं को सुधारता है, और अंततः सुपरइंटेलिजेंस बनकर विकसित होता है:

- **AI स्वायत्त R&D प्लेटफ़ॉर्म** — Agent स्वतंत्र रूप से पूर्ण सॉफ़्टवेयर विकास जीवनचक्र पूरा करते हैं, नियमित कोडिंग कार्यों में मानव इंजीनियरों की आवश्यकता के बिना
- **सेल्फ-इवॉल्विंग Agent इंजन** — Agent लगातार त्रुटियों से सीखते हैं, कोडबेस से ज्ञान सोखते हैं, और उपयोगकर्ता प्रतिक्रिया से विकसित होते हैं
- **प्रोग्रामर-Agent सहयोग केंद्र** — हर प्रोग्रामर के पास एक व्यक्तिगत "डेवलपमेंट प्रोजेक्ट" होता है जिसमें कई समानांतर सत्र होते हैं, और एक केंद्रीय शेड्यूलर समवर्ती संघर्षों को रोकता है
- **एंटरप्राइज़ SaaS प्लेटफ़ॉर्म** — मल्टी-टैनेंट आइसोलेशन, स्तरित अनुमतियाँ, लोचदार बिलिंग, और एंटरप्राइज़ एकीकरण (Feishu/DingTalk/WeCom/LDAP)
- **सुपरइंटेलिजेंस इनक्यूबेटर** — निरंतर विकास के माध्यम से, एकल Agent अंततः एक पूर्ण सॉफ़्टवेयर टीम की व्यापक क्षमताओं तक पहुँचता है

> "हर एंटरप्राइज़ के पास एक कभी न रुकने वाली, लगातार विकसित होने वाली AI सुपर R&D टीम हो — टूल उपयोगकर्ता से, कोड निर्माता तक, अंततः एक स्व-प्रतिकृति सुपरइंटेलिजेंस बनकर। आइए हम AGI की ओर जाने वाले रास्ते पर एक साथ चलें।"`,

  'README.ar.md': `DeepThink، منصة تطوّر ذاتي لذكاء فائق Agent المؤسسية، رائدة في التحول من نموذج Harness Engineering إلى Loop Engineering، هي الجيل الجديد من بنية الذكاء الاصطناعي (AI Infra) للعملاء المؤسسيين. تتمحور منصة DeepThink حول إطار تعاون متعدد العوامل (Agent)، وتدمج AI Coding و Self-Evolving و Full-Stack Observability و Bug Auto-Fix Loop و Human-Agent Symbiosis لبناء نظام ذكاء اصطناعي مؤسسي يتعلم باستمرار ويحسّن نفسه وينمو في النهاية ليصبح ذكاءً فائقاً:

- **منصة البحث والتطوير الذاتية بالذكاء الاصطناعي** — يكمل العامل (Agent) بشكل مستقل دورة حياة تطوير البرمجيات الكاملة، دون الحاجة إلى مهندسين بشريين في مهام الترميز الروتينية
- **محرك العامل ذي التطور الذاتي** — يتعلم العامل باستمرار من الأخطاء، ويمتص المعرفة من قاعدة الشيفرة، ويتطور من ملاحظات المستخدمين
- **مركز تعاون المبرمج والعامل** — يمتلك كل مبرمج "مشروع تطوير" شخصياً يحتوي على جلسات متوازية متعددة، ويمنع جدول مركزي تعارضات التزامن
- **منصة SaaS مؤسسية** — عزل متعدد المستأجرين، أذونات هرمية، فوترة مرنة، وتكاملات مؤسسية (Feishu/DingTalk/WeCom/LDAP)
- **حاضنة الذكاء الفائق** — من خلال التطور المستمر، يصل عامل واحد في النهاية إلى القدرات الشاملة لفريق برمجيات كامل

> "لتمتلك كل مؤسسة فريق بحث وتطوير فائق للذكاء الاصطناعي لا يتوقف أبداً ويتطور باستمرار — من مستخدم للأدوات، إلى مُنشئ للشيفرة، لينمو أخيراً ليصبح ذكاءً فائقاً ذاتي التكاثر. لنمشِ معاً على الطريق نحو AGI."`,

  'README.bn.md': `DeepThink, একটি এন্টারপ্রাইজ-গ্রেড স্বায়ত্ত Agent সেল্ফ-ইভল্ভিং সুপারইন্টেলিজেন্স প্ল্যাটফর্ম, Harness Engineering থেকে Loop Engineering প্যারাডাইমে রূপান্তরের পথিক, এন্টারপ্রাইজ গ্রাহকদের জন্য নতুন প্রজন্মের AI ইনফ্রাস্ট্রাকচার (AI Infra)। DeepThink প্ল্যাটফর্ম একটি মাল্টি-Agent সহযোগিতা ফ্রেমওয়ার্ককে কেন্দ্র করে, AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, এবং Human-Agent Symbiosis কে একত্রিত করে এমন একটি এন্টারপ্রাইজ-গ্রেড AI সিস্টেম গড়ে তোলে যা ক্রমাগত শেখে, নিজেকে উন্নত করে, এবং পরিশেষে সুপারইন্টেলিজেন্সে পরিণত হয়:

- **AI স্বায়ত্ত R&D প্ল্যাটফর্ম** — Agent স্বাধীনভাবে সম্পূর্ণ সফটওয়্যার ডেভেলপমেন্ট লাইফসাইকেল সম্পন্ন করে, নিয়মিত কোডিং কাজে মানব প্রকৌশলীদের প্রয়োজন ছাড়াই
- **সেল্ফ-ইভল্ভিং Agent ইঞ্জিন** — Agent ক্রমাগত ত্রুটি থেকে শেখে, কোডবেস থেকে জ্ঞান শোষণ করে, এবং ব্যবহারকারী প্রতিক্রিয়া থেকে বিকশিত হয়
- **প্রোগ্রামার-Agent সহযোগিতা কেন্দ্র** — প্রতিটি প্রোগ্রামারের একটি ব্যক্তিগত "ডেভেলপমেন্ট প্রজেক্ট" থাকে যাতে একাধিক সমান্তরাল সেশন থাকে, এবং একটি কেন্দ্রীয় শিডিউলার কনকারেন্সি দ্বন্দ্ব রোধ করে
- **এন্টারপ্রাইজ SaaS প্ল্যাটফর্ম** — মাল্টি-টেন্যান্ট আইসোলেশন, স্তরিত অনুমতি, স্থিতিস্থাপক বিলিং, এবং এন্টারপ্রাইজ ইন্টিগ্রেশন (Feishu/DingTalk/WeCom/LDAP)
- **সুপারইন্টেলিজেন্স ইনকিউবেটর** — ক্রমাগত বিবর্তনের মাধ্যমে, একটি একক Agent শেষ পর্যন্ত একটি সম্পূর্ণ সফটওয়্যার টিমের সর্বাঙ্গীণ সক্ষমতা অর্জন করে

> "প্রতিটি এন্টারপ্রাইজ যেন একটি কখনও থামে না এমন, ক্রমাগত বিকশিত হওয়া AI সুপার R&D টিমের মালিক হয় — টুল ব্যবহারকারী থেকে, কোড নির্মাতায়, পরিশেষে একটি স্ব-প্রতিলিপিকৃত সুপারইন্টেলিজেন্সে পরিণত হয়ে। আসুন আমরা AGI-এর দিকে যাওয়া পথে একসাথে চলি।"`,

  'README.pt.md': `DeepThink, uma plataforma de auto-evolução de superinteligência Agent autônoma de nível corporativo, pioneira na transição do paradigma Harness Engineering para o Loop Engineering, é a nova geração de Infraestrutura de IA (AI Infra) para clientes corporativos. A plataforma DeepThink centra-se em um framework de colaboração multi-Agent, fundindo AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop e Human-Agent Symbiosis para construir um sistema de IA corporativo que aprende continuamente, auto-aprimora-se e, em última análise, cresce até se tornar uma superinteligência:

- **Plataforma de P&D Autônoma com IA** — Os Agent completam de forma independente o ciclo de vida completo de desenvolvimento de software, sem a necessidade de engenheiros humanos em tarefas de codificação rotineiras
- **Motor de Agent Auto-Evolutivo** — Os Agent aprendem continuamente com os erros, absorvem conhecimento da base de código e evoluem a partir do feedback dos usuários
- **Centro de Colaboração Programador-Agent** — Cada programador possui um "Projeto de Desenvolvimento" pessoal com múltiplas sessões paralelas, e um agendador central evita conflitos de concorrência
- **Plataforma SaaS Corporativa** — Isolamento multi-tenant, permissões em níveis, faturamento elástico e integrações corporativas (Feishu/DingTalk/WeCom/LDAP)
- **Incubadora de Superinteligência** — Através da evolução contínua, um único Agent acaba atingindo as capacidades abrangentes de uma equipe de software completa

> "Que cada empresa possua uma equipe de P&D super de IA que nunca para e evolui continuamente — de usuário de ferramentas, a criador de código, crescendo por fim em uma superinteligência auto-replicante. Caminhemos juntos no caminho rumo à AGI."`,

  'README.ru.md': `DeepThink — корпоративная платформа самоэволюции автономного Agent-суперинтеллекта, пионер перехода от парадигмы Harness Engineering к Loop Engineering, новое поколение AI-инфраструктуры (AI Infra) для корпоративных клиентов. Платформа DeepThink построена вокруг фреймворка многого Agent-взаимодействия, объединяя AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop и Human-Agent Symbiosis для создания корпоративной AI-системы, которая непрерывно учится, самосовершенствуется и в конечном итоге вырастает в суперинтеллект:

- **Платформа автономной AI-разработки** — Agent независимо проходит полный жизненный цикл разработки ПО, исключая участие инженеров-людей в рутинных задачах кодирования
- **Движок самоэволюционирующего Agent** — Agent непрерывно учится на ошибках, поглощает знания из кодовой базы и эволюционирует на основе отзывов пользователей
- **Центр сотрудничества программиста и Agent** — У каждого программиста есть личный "Проект разработки" с несколькими параллельными сессиями, а центральный планировщик предотвращает конфликты параллелизма
- **Корпоративная SaaS-платформа** — Мультитенантная изоляция, иерархические права, эластичный биллинг и корпоративные интеграции (Feishu/DingTalk/WeCom/LDAP)
- **Инкубатор суперинтеллекта** — Посредством непрерывной эволюции единичный Agent в конечном итоге обретает комплексные возможности полноценной программной команды

> "Пусть у каждого предприятия будет никогда не останавливающаяся, непрерывно эволюционирующая AI-суперкоманда R&D — от пользователя инструментов, до создателя кода, в конечном итоге вырастающая в самовоспроизводящийся суперинтеллект. Пройдем этот путь к AGI вместе."`,

  'README.ja.md': `DeepThink、エンタープライズグレードの自律型 Agent 自己進化スーパーインテリジェンスプラットフォーム。Harness Engineering から Loop Engineering パラダイムへの移行の先駆者であり、エンタープライズ顧客向けの次世代 AI インフラストラクチャ（AI Infra）です。DeepThink プラットフォームはマルチ Agent コラボレーションフレームワークを中核とし、AI Coding、Self-Evolving、Full-Stack Observability、Bug Auto-Fix Loop、Human-Agent Symbiosis を融合して、継続的に学習し自己改善し、最終的にスーパーインテリジェンスへと成長するエンタープライズグレードの AI システムを構築します：

- **AI 自律型 R&D プラットフォーム** — Agent がソフトウェア開発の全ライフサイクルを独立して完遂し、ルーチンなコーディング作業に人間エンジニアを必要としません
- **自己進化型 Agent エンジン** — Agent はエラーから継続的に学び、コードベースから知識を吸収し、ユーザーフィードバックから進化します
- **プログラマー-Agent コラボレーションハブ** — 各プログラマーは複数の並列セッションを含む個人「開発プロジェクト」を持ち、中央スケジューラが並行処理の競合を防ぎます
- **エンタープライズ SaaS プラットフォーム** — マルチテナント分離、階層型権限、弾力的な課金、エンタープライズ連携（Feishu/DingTalk/WeCom/LDAP）
- **スーパーインテリジェンスインキュベータ** — 継続的な進化を通じて、単一の Agent は最終的に完全なソフトウェアチームの総合的な能力を獲得します

> 「すべての企業が、決して止まることなく継続的に進化する AI スーパー R&D チームを持てるように — ツールの利用者から、コードの創造者へ、最終的には自己増殖するスーパーインテリジェンスへと成長する。AGI への道を共に歩んでいきましょう。」`,

  'README.de.md': `DeepThink, eine Unternehmens-Plattform zur Selbst-Evolution autonomen Agent-Superintelligenz, Pionier im Übergang vom Harness Engineering- zum Loop Engineering-Paradigma, ist die nächste Generation der AI-Infrastruktur (AI Infra) für Unternehmenskunden. Die DeepThink-Plattform zentriert sich auf ein Multi-Agent-Kollaborations-Framework und verbindet AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop und Human-Agent Symbiosis, um ein Unternehmens-AI-System zu bauen, das kontinuierlich lernt, sich selbst verbessert und letztlich zur Superintelligenz heranwächst:

- **AI-Autonome R&D-Plattform** — Agent absolvieren unabhängig den gesamten Software-Entwicklungslebenszyklus, ohne menschliche Ingenieure bei routinemäßigen Codierungsaufgaben zu benötigen
- **Self-Evolving-Agent-Engine** — Agent lernen kontinuierlich aus Fehlern, saugen Wissen aus der Codebasis auf und entwickeln sich aus Nutzerfeedback weiter
- **Programmierer-Agent-Kollaborations-Hub** — Jeder Programmierer besitzt ein persönliches „Entwicklungsprojekt" mit mehreren parallelen Sitzungen, und ein zentraler Scheduler verhindert Nebenläufigkeitskonflikte
- **Unternehmens-SaaS-Plattform** — Multi-Tenant-Isolierung, gestaffelte Berechtigungen, elastische Abrechnung und Unternehmens-Integrationen (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligenz-Inkubator** — Durch kontinuierliche Evolution erlangt ein einzelner Agent schließlich die umfassenden Fähigkeiten eines vollständigen Software-Teams

> „Jedes Unternehmen soll ein nie innehaltendes, sich kontinuierlich entwickelndes AI-Super-R&D-Team besitzen — vom Werkzeugnutzer, zum Code-Ersteller, schließlich heranwachsend zu einer selbst-replizierenden Superintelligenz. Lasst uns gemeinsam auf dem Weg zur AGI schreiten."`,

  'README.fr.md': `DeepThink, une plateforme d'auto-évolution de superintelligence Agent autonome de niveau entreprise, pionnière dans la transition du paradigme Harness Engineering vers Loop Engineering, est la nouvelle génération d'Infrastructure IA (AI Infra) pour les clients entreprise. La plateforme DeepThink s'articule autour d'un framework de collaboration multi-Agent, fusionnant AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop et Human-Agent Symbiosis pour bâtir un système d'IA d'entreprise qui apprend continuellement, s'auto-améliore et, in fine, se développe pour devenir une superintelligence :

- **Plateforme de R&D Autonome par IA** — Les Agent accomplissent indépendamment le cycle de vie complet de développement logiciel, sans nécessiter d'ingénieurs humains pour les tâches de codage routinières
- **Moteur Agent Auto-Évolutif** — Les Agent apprennent continuellement des erreurs, absorbent le savoir de la base de code et évoluent à partir des retours utilisateurs
- **Hub de Collaboration Programmateur-Agent** — Chaque programmateur possède un « Projet de Développement » personnel contenant plusieurs sessions parallèles, et un planificateur central empêche les conflits de concurrence
- **Plateforme SaaS d'Entreprise** — Isolation multi-tenant, permissions hiérarchisées, facturation élastique et intégrations d'entreprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubateur de Superintelligence** — Par l'évolution continue, un Agent unique finit par acquérir les capacités globales d'une équipe logicielle complète

> « Que chaque entreprise possède une super-équipe de R&D IA qui ne s'arrête jamais et évolue continuellement — de l'utilisateur d'outils, au créateur de code, pour finalement devenir une superintelligence auto-répliquante. Marchons ensemble sur la voie de l'AGI. »`,

  'README.id.md': `DeepThink, platform evolusi-diri superinteligensi Agent otonom kelas enterprise, perintis transisi dari paradigma Harness Engineering ke Loop Engineering, adalah generasi baru Infrastruktur AI (AI Infra) bagi pelanggan enterprise. Platform DeepThink berpusat pada kerangka kolaborasi multi-Agent, memadukan AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, dan Human-Agent Symbiosis untuk membangun sistem AI kelas enterprise yang belajar terus-menerus, meningkatkan diri, dan pada akhirnya tumbuh menjadi superinteligensi:

- **Platform R&D Otonom AI** — Agent menyelesaikan siklus hidup pengembangan perangkat lunak secara mandiri, tanpa perlu insinyur manusia pada tugas pengkodean rutin
- **Mesin Agent Evolusi-Diri** — Agent belajar terus-menerus dari kesalahan, menyerap pengetahuan dari basis kode, dan berevolusi dari umpan balik pengguna
- **Hub Kolaborasi Programmer-Agent** — Setiap programmer memiliki "Proyek Pengembangan" pribadi yang berisi beberapa sesi paralel, dan penjadwal pusat mencegah konflik konkurensi
- **Platform SaaS Enterprise** — Isolasi multi-tenant, perizinan bertingkat, penagihan elastis, dan integrasi enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligensi** — Melalui evolusi berkelanjutan, satu Agent akhirnya mencapai kapabilitas komprehensif sebuah tim perangkat lunak lengkap

> "Semoga setiap enterprise memiliki tim R&D super AI yang tidak pernah berhenti dan terus berevolusi — dari pengguna alat, menjadi pencipta kode, pada akhirnya tumbuh menjadi superinteligensi yang mereplikasi diri. Mari berjalan bersama di jalan menuju AGI."`,

  'README.ur.md': `DeepThink، ایک انٹرپرائز گریڈ خودمختار Agent سیلف-ایویالوینگ سپر انٹیلیجنس پلیٹ فارم، Harness Engineering سے Loop Engineering پیٹرن تک منتقلی کا علمبردار، انٹرپرائز گاہکوں کے لیے نئی نسل کا AI انفراسٹرکچر (AI Infra) ہے۔ DeepThink پلیٹ فارم ایک ملٹی-Agent تعاون کے فریم ورک پر مرکوز ہے، جو AI Coding، Self-Evolving، Full-Stack Observability، Bug Auto-Fix Loop اور Human-Agent Symbiosis کو یکجا کرتا ہے تاکہ ایک انٹرپرائز گریڈ AI سسٹم بنایا جا سکے جو مسلسل سیکھتا ہے، خود کو بہتر کرتا ہے، اور بالآخر سپر انٹیلیجنس بن کر ترقی پاتا ہے:

- **AI خودمختار R&D پلیٹ فارم** — Agent آزادانہ طور پر مکمل سافٹ ویئر ڈیولپمنٹ لائف سائیکل مکمل کرتے ہیں، معمولی کوڈنگ کاموں میں انسانی انجینئرز کی ضرورت کے بغیر
- **سیلف-ایویالوینگ Agent انجن** — Agent مسلسل غلطیوں سے سیکھتے ہیں، کوڈ بیس سے علم جذب کرتے ہیں، اور صارف فیڈبیک سے ترقی کرتے ہیں
- **پروگرامر-Agent تعاون کا مرکز** — ہر پروگرامر کے پاس ایک ذاتی "ڈیولپمنٹ پروجیکٹ" ہوتا ہے جس میں متعدد متوازی سیشنز ہوتے ہیں، اور ایک مرکزی شیڈولر متوازیت تنازعات کو روکتا ہے
- **انٹرپرائز SaaS پلیٹ فارم** — ملٹی ٹیننٹ آئسولیشن، درجہ بند اجازتیں، لچکدار بلنگ، اور انٹرپرائز انٹیگریشنز (Feishu/DingTalk/WeCom/LDAP)
- **سپر انٹیلیجنس انکیوبیٹر** — مسلسل ترقی کے ذریعے، ایک واحد Agent بالآخر ایک مکمل سافٹ ویئر ٹیم کی جامع صلاحیتوں تک پہنچ جاتا ہے

> "ہر انٹرپرائز کے پاس ایک ایسی AI سپر R&D ٹیم ہو جو کبھی نہ رکے اور مسلسل ترقی کرے — ٹول صارف سے، کوڈ تخلیق کار تک، بالآخر ایک سیلف-ریپلیکیٹنگ سپر انٹیلیجنس بن کر۔ آئے ہم AGI کی طرف جانے والے راستے پر ساتھ چلیں۔"`,

  'README.mr.md': `DeepThink, एंटरप्राइज-ग्रेड स्वायत्त Agent सेल्फ-इव्हॉल्व्हिंग सुपरइंटेलिजन्स प्लॅटफॉर्म, Harness Engineering वरून Loop Engineering प्रतिमानापर्यंतच्या संक्रमणाचा अग्रदूत, एंटरप्राइज ग्राहकांसाठी नवीन पिढीचे AI इन्फ्रास्ट्रक्चर (AI Infra) आहे. DeepThink प्लॅटफॉर्म मल्टी-Agent सहकार्य फ्रेमवर्कवर केंद्रित आहे, जे AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop आणि Human-Agent Symbiosis यांना एकत्रित करून एक एंटरप्राइज-ग्रेड AI प्रणाली तयार करते जी सतत शिकते, स्वतःची सुधारणा करते आणि शेवटी सुपरइंटेलिजन्स म्हणून वाढते:

- **AI स्वायत्त R&D प्लॅटफॉर्म** — Agent स्वतंत्रपणे संपूर्ण सॉफ्टवेअर डेव्हलपमेंट जीवनचक्र पूर्ण करतात, नियमित कोडिंग कार्यांमध्ये मानवी अभियंत्यांची गरज न ठेवता
- **सेल्फ-इव्हॉल्व्हिंग Agent इंजिन** — Agent सतत चुकींपासून शिकतात, कोडबेसमधून ज्ञान शोषतात, आणि वापरकर्ता अभिप्रायांपासून विकसित होतात
- **प्रोग्रामर-Agent सहकार्य केंद्र** — प्रत्येक प्रोग्रामरकडे एक वैयक्तिक "डेव्हलपमेंट प्रोजेक्ट" असते ज्यामध्ये अनेक समांतर सत्रे असतात, आणि एक केंद्रीय शेड्यूलर समवर्ती संघर्ष टाळतो
- **एंटरप्राइज SaaS प्लॅटफॉर्म** — मल्टी-टेनंट आयसोलेशन, स्तरित परवानग्या, लवचिक बिलिंग, आणि एंटरप्राइज एकीकरण (Feishu/DingTalk/WeCom/LDAP)
- **सुपरइंटेलिजन्स इन्क्यूबेटर** — सातत्यपूर्ण उत्क्रांतीद्वारे, एकल Agent शेवटी संपूर्ण सॉफ्टवेअर टीमची सर्वांगीण क्षमता मिळवतो

> "प्रत्येक एंटरप्राइजकडे अशी AI सुपर R&D टीम असावी जी कधीच थांबत नाही आणि सतत विकसित होत राहते — टूल वापरकर्त्यापासून, कोड निर्मात्यापर्यंत, शेवटी स्वतःची प्रतिकृती करणाऱ्या सुपरइंटेलिजन्सपर्यंत वाढत. चला AGI कडे जाणाऱ्या मार्गावर एकत्र चालूया."`,

  'README.te.md': `DeepThink, ఎంటర్‌ప్రైజ్-గ్రేడ్ స్వయంచాలక Agent సెల్ఫ్-ఎవాల్వింగ్ సూపర్‌ఇంటెలిజెన్స్ ప్లాట్‌ఫారమ్, Harness Engineering నుండి Loop Engineering పారాడైమ్‌కు పరివర్తనలో మార్గదర్శి, ఎంటర్‌ప్రైజ్ కస్టమర్‌ల కోసం కొత్త తరం AI ఇన్‌ఫ్రాస్ట్రక్చర్ (AI Infra)। DeepThink ప్లాట్‌ఫారమ్ మల్టీ-Agent సహకార ఫ్రేమ్‌వర్క్‌ను కేంద్రంగా చేసుకుంటుంది, AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop మరియు Human-Agent Symbiosis లను అనుసంధించి ఒక ఎంటర్‌ప్రైజ్-గ్రేడ్ AI వ్యవస్థను నిర్మిస్తుంది, ఇది నిరంతరం నేర్చుకుంటుంది, స్వీయ-మెరుగుదల చేస్తుంది, మరియు చివరకు సూపర్‌ఇంటెలిజెన్స్‌గా ఎదుగుతుంది:

- **AI స్వయంచాలక R&D ప్లాట్‌ఫారమ్** — Agent స్వతంత్రంగా పూర్తి సాఫ్ట్‌వేర్ డెవలప్‌మెంట్ జీవిత చక్రాన్ని పూర్తి చేస్తాయి, రొటీన్ కోడింగ్ పనులలో మానవ ఇంజనీర్ల అవసరం లేకుండా
- **సెల్ఫ్-ఎవాల్వింగ్ Agent ఇంజిన్** — Agent నిరంతరం తప్పుల నుండి నేర్చుకుంటాయి, కోడ్‌బేస్ నుండి జ్ఞానాన్ని గ్రహిస్తాయి, మరియు వినియోగదారు ఫీడ్‌బ్యాక్ నుండి పరిణామం చెందుతాయి
- **ప్రోగ్రామర్-Agent సహకార కేంద్రం** — ప్రతి ప్రోగ్రామర్‌కు వ్యక్తిగత "డెవలప్‌మెంట్ ప్రాజెక్ట్" ఉంటుంది దీనిలో బహుళ సమాంతర సెషన్‌లు ఉంటాయి, మరియు కేంద్ర షెడ్యూలర్ కాన్కరెన్సీ ఘర్షణలను నివారిస్తుంది
- **ఎంటర్‌ప్రైజ్ SaaS ప్లాట్‌ఫారమ్** — మల్టీ-టెనెంట్ ఐసోలేషన్, స్థాయి అనుమతులు, సాగే బిల్లింగ్, మరియు ఎంటర్‌ప్రైజ్ ఇంటిగ్రేషన్‌లు (Feishu/DingTalk/WeCom/LDAP)
- **సూపర్‌ఇంటెలిజెన్స్ ఇన్క్యుబేటర్** — నిరంతర పరిణామం ద్వారా, ఒకే Agent చివరకు పూర్తి సాఫ్ట్‌వేర్ టీమ్ యొక్క సమగ్ర సామర్థ్యాలను సాధిస్తుంది

> "ప్రతి ఎంటర్‌ప్రైజ్ దగ్గర ఎప్పటికీ ఆగని, నిరంతరం పరిణామం చెందుతున్న AI సూపర్ R&D టీమ్ ఉండాలి — టూల్ వినియోగదారు నుండి, కోడ్ సృష్టికర్తగా, చివరకు స్వీయ-ప్రతిరూప సూపర్‌ఇంటెలిజెన్స్‌గా ఎదుగుతూ. మనం అందరం AGI వైపు వెళ్ళే మార్గంలో కలిసి నడుద్దాం."`,

  'README.tr.md': `DeepThink, kurumsal düzeyde özerk Agent kendi-evrilen süper-zeka platformu; Harness Engineering'den Loop Engineering paradigmasına geçişin öncüsü; kurumsal müşteriler için yeni nesil AI Altyapısıdır (AI Infra). DeepThink platformu çok-Agent işbirliği çerçevesini merkeze alır; AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop ve Human-Agent Symbiosis'i harmanlayarak sürekli öğrenen, kendini geliştiren ve nihayetinde süper-zekaya dönüşen kurumsal bir AI sistemi inşa eder:

- **AI Özerk Ar-Ge Platformu** — Agent'lar yazılım geliştirme yaşam döngüsünün tamamını bağımsız olarak tamamlar; rutin kodlama görevlerinde insan mühendislere ihtiyaç duymaz
- **Kendi-Evrilen Agent Motoru** — Agent'lar hatalardan sürekli öğrenir, kod tabanından bilgi emer ve kullanıcı geri bildirimlerinden evrilir
- **Programcı-Agent İşbirliği Merkezi** — Her programcının birden çok paralel oturum içeren kişisel bir "Geliştirme Projesi" vardır; merkezi zamanlayıcı eşzamanlılık çakışmalarını önler
- **Kurumsal SaaS Platformu** — Çok-kiracılı izolasyon, katmanlı izinler, esnek faturalama ve kurumsal entegrasyonlar (Feishu/DingTalk/WeCom/LDAP)
- **Süper-zeka Kuluçka Makinesi** — Sürekli evrim yoluyla, tek bir Agent nihayetinde eksiksiz bir yazılım ekibinin kapsamlı yeteneklerine erişir

> "Her kuruluş, asla durmayan, sürekli evrilen bir AI süper Ar-Ge ekibine sahip olsun — araç kullanıcısından, kod yaratıcısına, nihayetinde kendini çoğaltan bir süper-zekaya büyüyerek. AGI'ye giden yolda birlikte yürüyelim."`,

  'README.ta.md': `DeepThink, நிறுவன நிலை தன்னாட்சி Agent சுய-பரிணாம சூப்பர்-நுண்ணறிவு தளம், Harness Engineering இலிருந்து Loop Engineering மாதிரிக்கு மாறுவதில் முன்னோடி, நிறுவன வாடிக்கையாளர்களுக்கான புதிய தலைமுறை AI உள்கட்டமைப்பு (AI Infra) ஆகும். DeepThink தளம் பல-Agent ஒத்துழைப்பு கட்டமைப்பை மையமாகக் கொண்டு, AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop மற்றும் Human-Agent Symbiosis ஆகியவற்றை இணைத்து, தொடர்ந்து கற்றுக்கொள்ளும், தன்னை மேம்படுத்திக்கொள்ளும், இறுதியில் சூப்பர்-நுண்ணறிவாக வளரும் நிறுவன நிலை AI அமைப்பை உருவாக்குகிறது:

- **AI தன்னாட்சி R&D தளம்** — Agent-கள் முழு மென்பொருள் உருவாக்க வாழ்க்கைச் சுழற்சியையும் சுயமாக நிறைவு செய்கின்றன; வழக்கமான குறியீட்டுப் பணிகளில் மனித பொறியாளர்களின் தேவை இல்லை
- **சுய-பரிணாம Agent இயந்திரம்** — Agent-கள் தவறுகளிலிருந்து தொடர்ந்து கற்றுக்கொள்கின்றன, குறியீட்டுத் தளத்திலிருந்து அறிவை உறிஞ்சுகின்றன, பயனர் கருத்துக்களிலிருந்து பரிணமிக்கின்றன
- **நிரலாளர்-Agent ஒத்துழைப்பு மையம்** — ஒவ்வொரு நிரலாளருக்கும் பல இணையான அமர்வுகளைக் கொண்ட தனிப்பட்ட "உருவாக்கத் திட்டம்" உள்ளது; மைய அட்டவணை ஒரே நேரத்தில் நிகழும் முரண்பாடுகளைத் தடுக்கிறது
- **நிறுவன SaaS தளம்** — பல-குத்தக்காரர் தனிமைப்படுத்தல், அடுக்கு அனுமதிகள், நெகிழ் பில்லிங், நிறுவன ஒருங்கிணைப்புகள் (Feishu/DingTalk/WeCom/LDAP)
- **சூப்பர்-நுண்ணறிவு அடைப்பான்** — தொடர் பரிணாமத்தின் மூலம், ஒற்றை Agent இறுதியில் முழுமையான மென்பொருள் குழுவின் விரிவான திறன்களை அடைகிறது

> "ஒவ்வொரு நிறுவனத்திடமும் ஒரு போதும் நிற்காத, தொடர்ந்து பரிணமிக்கும் AI சூப்பர் R&D குழு இருக்கட்டும் — கருவி பயனரிலிருந்து, குறியீடு உருவாக்குநராக, இறுதியில் சுய-படியெடுக்கும் சூப்பர்-நுண்ணறிவாக வளர்ந்து. AGI நோக்கிய பாதையில் ஒன்றாக நடப்போம்."`,

  'README.ko.md': `DeepThink, 엔터프라이즈급 자율형 Agent 자가진화 슈퍼인텔리전스 플랫폼, Harness Engineering에서 Loop Engineering 패러다임으로의 전환을 선도하는 개척자, 기업 고객을 위한 차세대 AI 인프라(AI Infra)입니다. DeepThink 플랫폼은 멀티-Agent 협업 프레임워크를 중심으로 AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, Human-Agent Symbiosis를 융합하여 지속적으로 학습하고 자기 개선하며 궁극적으로 슈퍼인텔리전스로 성장하는 엔터프라이즈급 AI 시스템을 구축합니다:

- **AI 자율 R&D 플랫폼** — Agent가 소프트웨어 개발의 전체 라이프사이클을 독립적으로 완수하며, 루틴한 코딩 작업에 인간 엔지니어의 개입이 불필요합니다
- **자가진화 Agent 엔진** — Agent는 오류로부터 지속적으로 학습하고, 코드베이스에서 지식을 흡수하며, 사용자 피드백으로부터 진화합니다
- **프로그래머-Agent 협업 허브** — 모든 프로그래머는 여러 병렬 세션을 포함하는 개인 "개발 프로젝트"를 소유하며, 중앙 스케줄러가 동시성 충돌을 방지합니다
- **엔터프라이즈 SaaS 플랫폼** — 멀티테넌트 격리, 계층적 권한, 탄력적 과금, 기업 통합(Feishu/DingTalk/WeCom/LDAP)
- **슈퍼인텔리전스 인큐베이터** — 지속적 진화를 통해 단일 Agent는 궁극적으로 완전한 소프트웨어 팀의 종합적 역량을 갖추게 됩니다

> "모든 기업이 결코 멈추지 않고 지속적으로 진화하는 AI 슈퍼 R&D 팀을 소유하기를 — 도구 사용자에서, 코드 창조자로, 궁극적으로 자가 복제하는 슈퍼인텔리전스로 성장하며. AGI를 향한 길에서 함께 걸어갑시다."`,

  'README.vi.md': `DeepThink, nền tảng siêu trí tuệ tự tiến hóa Agent tự chủ cấp doanh nghiệp, nhà tiên phong trong chuyển dịch từ mô hình Harness Engineering sang Loop Engineering, là thế hệ mới của Hạ tầng AI (AI Infra) dành cho khách hàng doanh nghiệp. Nền tảng DeepThink lấy khung cộng tác đa-Agent làm trung tâm, kết hợp AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop và Human-Agent Symbiosis để xây dựng một hệ thống AI cấp doanh nghiệp liên tục học hỏi, tự cải thiện và cuối cùng phát triển thành siêu trí tuệ:

- **Nền tảng R&D tự chủ bằng AI** — Agent độc lập hoàn thành toàn bộ vòng đời phát triển phần mềm, không cần kỹ sư con người trong các tác vụ mã hóa thường lệ
- **Động cơ Agent tự tiến hóa** — Agent liên tục học từ lỗi, hấp thụ tri thức từ cơ sở mã, và tiến hóa từ phản hồi người dùng
- **Trung tâm cộng tác Lập trình viên-Agent** — Mỗi lập trình viên sở hữu một "Dự án Phát triển" cá nhân chứa nhiều phiên song song, bộ lập lịch trung tâm ngăn xung đột đồng thời
- **Nền tảng SaaS doanh nghiệp** — Cô lập multi-tenant, quyền hạn theo tầng, thanh toán linh hoạt, tích hợp doanh nghiệp (Feishu/DingTalk/WeCom/LDAP)
- **Ấp ủ siêu trí tuệ** — Thông qua tiến hóa liên tục, một Agent duy nhất cuối cùng đạt được năng lực toàn diện của một đội phần mềm hoàn chỉnh

> "Mong mỗi doanh nghiệp sở hữu một đội R&D siêu AI không bao giờ dừng lại và liên tục tiến hóa — từ người dùng công cụ, sang người kiến tạo mã, cuối cùng phát triển thành siêu trí tuệ tự tái tạo. Hãy cùng bước trên con đường tiến tới AGI."`,

  'README.it.md': `DeepThink, una piattaforma di auto-evoluzione della superintelligenza Agent autonoma di livello enterprise, pioniera nella transizione dal paradigma Harness Engineering al Loop Engineering, è la nuova generazione di Infrastruttura AI (AI Infra) per clienti enterprise. La piattaforma DeepThink si centra su un framework di collaborazione multi-Agent, fondendo AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop e Human-Agent Symbiosis per costruire un sistema AI di livello enterprise che apprende continuamente, si auto-migliora e infine cresce fino a diventare una superintelligenza:

- **Piattaforma R&D Autonoma AI** — Gli Agent completano indipendentemente l'intero ciclo di vita dello sviluppo software, senza bisogno di ingegneri umani per le attività di codifica routinaria
- **Motore Agent Auto-Evolvente** — Gli Agent apprendono continuamente dagli errori, assorbono conoscenza dalla codebase e si evolvono dal feedback degli utenti
- **Hub di Collaborazione Programmatore-Agent** — Ogni programmatore possiede un "Progetto di Sviluppo" personale con multiple sessioni parallele, e uno scheduler centrale previene conflitti di concorrenza
- **Piattaforma SaaS Enterprise** — Isolamento multi-tenant, permessi a livelli, fatturazione elastica e integrazioni enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Incubatore di Superintelligenza** — Attraverso evoluzione continua, un singolo Agent infine acquisisce le capacità comprehensive di un team software completo

> "Che ogni enterprise possegga un team R&D super AI che non si ferma mai e si evolve continuamente — da utente di strumenti, a creatore di codice, crescendo infine in una superintelligenza auto-replicante. Camminiamo insieme sulla via verso l'AGI."`,

  'README.pl.md': `DeepThink, platforma samoewolucji superinteligencji Agent autonomicznej klasy enterprise, pionier w przejściu od paradygmatu Harness Engineering do Loop Engineering, to nowe pokolenie Infrastruktury AI (AI Infra) dla klientów enterprise. Platforma DeepThink skupia się na frameworku współpracy wielo-Agentowej, łącząc AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop oraz Human-Agent Symbiosis, aby zbudować system AI klasy enterprise, który stale się uczy, samodzielnie się poprawia i ostatecznie wzrasta do rangi superinteligencji:

- **Platforma Autonomicznego R&D AI** — Agent-y samodzielnie przechodzą pełny cykl życia tworzenia oprogramowania, eliminując potrzebę inżynierów ludzkich przy rutynowych zadaniach kodowania
- **Silnik Agent Samoewolucyjny** — Agent-y stale uczą się na błędach, absorbują wiedzę z bazy kodu i ewoluują na podstawie opinii użytkowników
- **Centrum Współpracy Programista-Agent** — Każdy programista posiada osobisty „Projekt Rozwoju" zawierający wiele równoległych sesji, a centralny scheduler zapobiega konfliktom współbieżności
- **Platforma SaaS Enterprise** — Izolacja multi-tenant, uprawnienia hierarchiczne, elastyczne fakturowanie i integracje enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligencji** — Poprzez ciągłą ewolucję, pojedynczy Agent ostatecznie uzyskuje wyczerpujące zdolności pełnego zespołu programistycznego

> „Niech każde przedsiębiorstwo posiada zespół R&D super AI, który nigdy nie ustaje i stale się rozwija — od użytkownika narzędzi, do twórcy kodu, ostatecznie wzrastając do samo-replikującej się superinteligencji. Kroczmy razem na drodze do AGI."`,

  'README.uk.md': `DeepThink — корпоративна платформа самоеволюції автономного Agent-суперінтелекту, піонер переходу від парадигми Harness Engineering до Loop Engineering, нове покоління AI-інфраструктури (AI Infra) для корпоративних клієнтів. Платформа DeepThink побудована навколо фреймворку багато-Agent-взаємодії, поєднуючи AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop та Human-Agent Symbiosis для створення корпоративної AI-системи, що безперервно навчається, самовдосконалюється і зрештою виростає до суперінтелекту:

- **Платформа автономної AI-розробки** — Agent самостійно проходить повний життєвий цикл розробки ПЗ, усуваючи потребу в людях-інженерах для рутинних завдань кодування
- **Движок самоеволюційного Agent** — Agent безперервно вчиться на помилках, поглинає знання з кодової бази та еволюціонує на основі відгуків користувачів
- **Центр співпраці програміста та Agent** — Кожен програміст має особистий «Проєкт розробки» з кількома паралельними сесіями, а центральний планувальник запобігає конфліктам паралелізму
- **Корпоративна SaaS-платформа** — Мультитенантна ізоляція, ієрархічні права, еластичний білінг та корпоративні інтеграції (Feishu/DingTalk/WeCom/LDAP)
- **Інкубатор суперінтелекту** — Через безперервну еволюцію єдиний Agent зрештою здобуває комплексні можливості повноцінної програмної команди

> «Хай кожне підприємство матиме команду AI-супер-R&D, що ніколи не зупиняється й безперервно еволюціонує — від користувача інструментів, до творця коду, зрештою виростаючи в само-репродукційний суперінтелект. Проймо цим шляхом до AGI разом.»`,

  'README.nl.md': `DeepThink, een enterprise-grade platform voor zelfevoluerende superintelligentie van autonome Agent, pionier in de overgang van het Harness Engineering- naar het Loop Engineering-paradigma, is de nieuwe generatie AI-infrastructuur (AI Infra) voor enterprise-klanten. Het DeepThink-platform centereert zich op een multi-Agent-samenwerkingsframework en combineert AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop en Human-Agent Symbiosis om een enterprise AI-systeem te bouwen dat continu leert, zichzelf verbetert en uiteindelijk uitgroeit tot superintelligentie:

- **AI-Autonome R&D-Platform** — Agent onafhankelijk het volledige software-ontwikkelingslevenscyclus doorlopen, zonder menselijke ingenieurs nodig voor routinematige codeertaken
- **Zelfevoluerende Agent-Engine** — Agent continu leren van fouten, kennis absorberen uit de codebase, en evolueren vanuit gebruikersfeedback
- **Programmeur-Agent-SamenwerkingsHub** — Elke programmeur bezit een persoonlijk „Ontwikkelingsproject" met meerdere parallelle sessies, en een centrale scheduler voorkomt concurrency-conflicten
- **Enterprise SaaS-Platform** — Multi-tenant-isolatie, gelaagde rechten, elastische facturering en enterprise-integraties (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligentie-Incubator** — Door continue evolutie bereikt een enkele Agent uiteindelijk de uitgebreide capaciteiten van een volledig softwareteam

> „Laat elke enterprise een AI-super-R&D-team bezitten dat nooit stilt en continu evolueert — van gereedschapsgebruiker, tot code-maker, uiteindelijk uitgroeidend tot een zelf-replicerende superintelligentie. Laten we samen wandelen op de weg naar AGI."`,

  'README.th.md': `DeepThink, แพลตฟอร์มสุดยอดปัญญาประดิษฐ์ Agent อิสระที่พัฒนาตนเองระดับองค์กร, ผู้บุกเบิกการเปลี่ยนผ่านจากพาราไดม์ Harness Engineering สู่ Loop Engineering, เป็นโครงสร้างพื้นฐาน AI (AI Infra) รุ่นใหม่สำหรับลูกค้าองค์กร แพลตฟอร์ม DeepThink ตั้งอยู่บนกรอบการทำงานร่วมกันแบบหลาย-Agent ผสานรวม AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop และ Human-Agent Symbiosis เพื่อสร้างระบบ AI ระดับองค์กรที่เรียนรู้อย่างต่อเนื่อง ปรับปรุงตนเอง และในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์:

- **แพลตฟอร์ม R&D อิสระด้วย AI** — Agent ทำงานครบทั้งวงจรชีวิตการพัฒนาซอฟต์แวร์ได้อย่างอิสระ โดยไม่ต้องพึ่งพาวิศวกรมนุษย์ในงานเขียนโค้ดประจำ
- **เอนจิน Agent พัฒนาตนเอง** — Agent เรียนรู้จากข้อผิดพลาดอย่างต่อเนื่อง ดูดซับความรู้จากฐานโค้ด และวิวัฒน์การจากผลตอบรับของผู้ใช้
- **ศูนย์กลางการทำงานร่วมระหว่างโปรแกรมเมอร์และ Agent** — โปรแกรมเมอร์ทุกคนมี "โปรเจกต์การพัฒนา" ส่วนตัวที่มีหลายเซสชันคู่ขนาน ตัวกำหนดเวลากลางป้องกันความขัดแย้งแบบเกิดพร้อมกัน
- **แพลตฟอร์ม SaaS ระดับองค์กร** — การแยก multi-tenant, สิทธิ์แบบหลายระดับ, การเรียกเก็บเงินแบบยืดหยุ่น, และการเชื่อมต่อองค์กร (Feishu/DingTalk/WeCom/LDAP)
- **ตัวฟักไข่สุดยอดปัญญาประดิษฐ์** — ผ่านการวิวัฒน์การอย่างต่อเนื่อง Agent เดียวในที่สุดจะบรรลุความสามารถรอบด้านของทีมซอฟต์แวร์ที่สมบูรณ์

> "ขอให้ทุกองค์กรมีทีม R&D ซูเปอร์ AI ที่ไม่หยุดนิ่งและวิวัฒน์การอย่างต่อเนื่อง — จากผู้ใช้เครื่องมือ, สู่ผู้สร้างโค้ด, ในที่สุดเติบโตเป็นสุดยอดปัญญาประดิษฐ์ที่สร้างซ้ำตัวเองได้ ให้เราเดินไปด้วยกันบนเส้นทางสู่ AGI"`,

  'README.gu.md': `DeepThink, એક એન્ટરપ્રાઇઝ-ગ્રેડ સ્વાયત્ત Agent સેલ્ફ-ઇવોલ્વિંગ સુપરઇન્ટેલિજન્સ પ્લેટફોર્મ, Harness Engineering થી Loop Engineering પેરાડાઇમ સુધીના સંક્રમણનો અગ્રણી, એન્ટરપ્રાઇઝ ગ્રાહકો માટે નવી પેઢીનું AI ઇન્ફ્રાસ્ટ્રક્ચર (AI Infra) છે. DeepThink પ્લેટફોર્મ મલ્ટિ-Agent સહયોગ ફ્રેમવર્કને કેન્દ્રમાં રાખે છે, AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop અને Human-Agent Symbiosis ને જોડીને એક એન્ટરપ્રાઇઝ-ગ્રેડ AI સિસ્ટમ બનાવે છે જે સતત શીખે છે, પોતાને સુધારે છે, અને અંતે સુપરઇન્ટેલિજન્સ તરીકે વિકસે છે:

- **AI સ્વાયત્ત R&D પ્લેટફોર્મ** — Agent સ્વતંત્રપણે સંપૂર્ણ સોફ્ટવેર ડેવલપમેન્ટ જીવનચક્ર પૂર્ણ કરે છે, નિયમિત કોડિંગ કાર્યોમાં માનવ એન્જિનિયર્સની જરૂર વગર
- **સેલ્ફ-ઇવોલ્વિંગ Agent એન્જિન** — Agent સતત ભૂલોમાંથી શીખે છે, કોડબેઝમાંથી જ્ઞાન શોષે છે, અને વપરાશકર્તા પ્રતિસાદમાંથી વિકસે છે
- **પ્રોગ્રામર-Agent સહયોગ કેન્દ્ર** — દરેક પ્રોગ્રામર પાસે વ્યક્તિગત "ડેવલપમેન્ટ પ્રોજેક્ટ" હોય છે જેમાં ઘણા સમાંતર સત્રો હોય છે, અને કેન્દ્રિય શેડ્યૂલર સમાનકાલિક સંઘર્ષ અટકાવે છે
- **એન્ટરપ્રાઇઝ SaaS પ્લેટફોર્મ** — મલ્ટિ-ટેનન્ટ અલગારા, સ્તરવાળી પરવાનગીઓ, લવચીક બિલિંગ, અને એન્ટરપ્રાઇઝ એકીકરણ (Feishu/DingTalk/WeCom/LDAP)
- **સુપરઇન્ટેલિજન્સ ઇન્ક્યુબેટર** — સતત ઇવોલ્યુશન દ્વારા, એકલ Agent અંતે સંપૂર્ણ સોફ્ટવેર ટીમની વ્યાપક ક્ષમતાઓ મેળવે છે

> "દરેક એન્ટરપ્રાઇઝ પાસે એક ક્યારેય ન રોકાતી, સતત વિકસતી AI સુપર R&D ટીમ હોય — ટૂલ વપરાશકર્તામાંથી, કોડ નિર્માતા સુધી, અંતે સ્વ-પ્રતિરૂપ સુપરઇન્ટેલિજન્સ બનીને. ચાલો આપણે AGI તરફ જતા માર્ગ પર સાથે ચાલીએ."`,

  'README.ms.md': `DeepThink, platform evolusi-diri superinteligensi Agent autonomi gred enterprise, perintis transisi dari paradigma Harness Engineering ke Loop Engineering, ialah generasi baru Infrastruktur AI (AI Infra) untuk pelanggan enterprise. Platform DeepThink berpusatkan rangka kerja kerjasama berbilang-Agent, menggabungkan AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop dan Human-Agent Symbiosis untuk membina sistem AI gred enterprise yang sentiasa belajar, memperbaiki diri dan akhirnya membesar menjadi superinteligensi:

- **Platform R&D Autonomi AI** — Agent melengkapkan kitaran hayat pembangunan perisian penuh secara bebas, tanpa memerlukan jurutera manusia pada tugasan pengekodan rutin
- **Enjin Agent Evolusi-Diri** — Agent sentiasa belajar daripada ralat, menyerap pengetahuan daripada pangkalan kod, dan berevolusi daripada maklum balas pengguna
- **Hab Kerjasama Pengaturcara-Agent** — Setiap pengaturcara memiliki "Projek Pembangunan" peribadi yang mengandungi berbilang sesi selari, dan penjadwal pusat menghalang konflik konkurensi
- **Platform SaaS Enterprise** — Pemencilan berbilang-tenant, kebenaran berperingkat, pengebilan anjal, dan integrasi enterprise (Feishu/DingTalk/WeCom/LDAP)
- **Inkubator Superinteligensi** — Melalui evolusi berterusan, satu Agent akhirnya mencapai keupayaan menyeluruh pasukan perisian lengkap

> "Semoga setiap enterprise memiliki pasukan R&D super AI yang tidak pernah berhenti dan terus berevolusi — daripada pengguna alat, kepada pencipta kod, akhirnya membesar menjadi superinteligensi yang mereplikasi diri. Mari berjalan bersama di jalan menuju AGI."`,

  'README.kn.md': `DeepThink, ಒಂದು ಎಂಟರ್‌ಪ್ರೈಸ್-ಗ್ರೇಡ್ ಸ್ವಾಯತ್ತ Agent ಸ್ವಯಂ-ವಿಕಸನೀಯ ಸೂಪರ್-ಇಂಟೆಲಿಜೆನ್ಸ್ ಪ್ಲಾಟ್‌ಫಾರಮ್, Harness Engineering ಇಂದ Loop Engineering ಪ್ಯಾರಾಡೈಮ್‌ಗೆ ಬದಲಾವಣೆಯ ಪ್ರವರ್ತಕ, ಎಂಟರ್‌ಪ್ರೈಸ್ ಗ್ರಾಹಕರಿಗಾಗಿ ಹೊಸ ತಲೆಮಾರಿನ AI ಇನ್‌ಫ್ರಾಸ್ಟ್ರಕ್ಚರ್ (AI Infra) ಆಗಿದೆ. DeepThink ಪ್ಲಾಟ್‌ಫಾರಮ್ ಮಲ್ಟಿ-Agent ಸಹಯೋಗ ಚೌಕಟ್ಟನ್ನು ಕೇಂದ್ರೀಕರಿಸುತ್ತದೆ, AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop ಮತ್ತು Human-Agent Symbiosis ಅನ್ನು ಸಂಯೋಜಿಸಿ ನಿರಂತರವಾಗಿ ಕಲಿಯುವ, ಸ್ವಯಂ-ಸುಧಾರಣೆ ಮಾಡಿಕೊಳ್ಳುವ, ಮತ್ತು ಅಂತಿಮವಾಗಿ ಸೂಪರ್-ಇಂಟೆಲಿಜೆನ್ಸ್ ಆಗಿ ಬೆಳೆಯುವ ಎಂಟರ್‌ಪ್ರೈಸ್-ಗ್ರೇಡ್ AI ವ್ಯವಸ್ಥೆಯನ್ನು ನಿರ್ಮಿಸುತ್ತದೆ:

- **AI ಸ್ವಾಯತ್ತ R&D ಪ್ಲಾಟ್‌ಫಾರಮ್** — Agent ಸ್ವತಂತ್ರವಾಗಿ ಸಂಪೂರ್ಣ ತಂತ್ರಾಂಶ ಅಭಿವೃದ್ಧಿ ಜೀವನಚಕ್ರವನ್ನು ಪೂರ್ಣಗೊಳಿಸುತ್ತದೆ, ನಿಯಮಿತ ಕೋಡಿಂಗ್ ಕಾರ್ಯಗಳಲ್ಲಿ ಮಾನವ ಎಂಜಿನಿಯರ್‌ಗಳ ಅಗತ್ಯವಿಲ್ಲದೆ
- **ಸ್ವಯಂ-ವಿಕಸನೀಯ Agent ಎಂಜಿನ್** — Agent ನಿರಂತರವಾಗಿ ದೋಷಗಳಿಂದ ಕಲಿಯುತ್ತದೆ, ಕೋಡ್‌ಬೇಸ್‌ನಿಂದ ಜ್ಞಾನವನ್ನು ಹೀರಿಕೊಳ್ಳುತ್ತದೆ, ಮತ್ತು ಬಳಕೆದಾರ ಪ್ರತಿಕ್ರಿಯೆಯಿಂದ ವಿಕಸನಗೊಳ್ಳುತ್ತದೆ
- **ಪ್ರೋಗ್ರಾಮರ್-Agent ಸಹಯೋಗ ಕೇಂದ್ರ** — ಪ್ರತಿ ಪ್ರೋಗ್ರಾಮರ್ ಬಹು ಸಮಾನಾಂತರ ಸೆಷನ್‌ಗಳನ್ನು ಹೊಂದಿರುವ ವೈಯಕ್ತಿಕ "ಡೆವಲಪ್‌ಮೆಂಟ್ ಪ್ರಾಜೆಕ್ಟ್" ಅನ್ನು ಹೊಂದಿರುತ್ತಾರೆ, ಮತ್ತು ಕೇಂದ್ರ ಶೆಡ್ಯೂಲರ್ ಕಾನ್ಕರೆನ್ಸಿ ಸಂಘರ್ಷವನ್ನು ತಡೆಯುತ್ತದೆ
- **ಎಂಟರ್‌ಪ್ರೈಸ್ SaaS ಪ್ಲಾಟ್‌ಫಾರಮ್** — ಮಲ್ಟಿ-ಟೆನಂಟ್ ಪ್ರತ್ಯೇಕತೆ, ಶ್ರೇಣೀಕೃತ ಅನುಮತಿಗಳು, ಸ್ಥಿತಿಸ್ಥಾಪಕ ಬಿಲ್ಲಿಂಗ್, ಮತ್ತು ಎಂಟರ್‌ಪ್ರೈಸ್ ಏಕೀಕರಣಗಳು (Feishu/DingTalk/WeCom/LDAP)
- **ಸೂಪರ್-ಇಂಟೆಲಿಜೆನ್ಸ್ ಇನ್ಕ್ಯುಬೇಟರ್** — ನಿರಂತರ ವಿಕಸನದ ಮೂಲಕ, ಏಕೈಕ Agent ಅಂತಿಮವಾಗಿ ಸಂಪೂರ್ಣ ತಂತ್ರಾಂಶ ತಂಡದ ಸಮಗ್ರ ಸಾಮರ್ಥ್ಯಗಳನ್ನು ಪಡೆಯುತ್ತದೆ

> "ಪ್ರತಿ ಎಂಟರ್‌ಪ್ರೈಸ್ ಎಂದಿಗೂ ನಿಲ್ಲದ, ನಿರಂತರವಾಗಿ ವಿಕಸನಗೊಳ್ಳುವ AI ಸೂಪರ್ R&D ತಂಡವನ್ನು ಹೊಂದಿರಲಿ — ಉಪಕರಣ ಬಳಕೆದಾರರಿಂದ, ಕೋಡ್ ಸೃಷ್ಟಿಕರ್ತರಾಗಿ, ಅಂತಿಮವಾಗಿ ಸ್ವಯಂ-ಪ್ರತಿಕೃತಿ ಸೂಪರ್-ಇಂಟೆಲಿಜೆನ್ಸ್ ಆಗಿ ಬೆಳೆಯಲಿ. ನಾವು AGI ಕಡೆಗೆ ಹೋಗುವ ದಾರಿಯಲ್ಲಿ ಒಟ್ಟಿಗೆ ನಡಕೊಯ್ದು."`,

  'README.fa.md': `DeepThink، یک پلتفرم خود-تکامل‌یافته ابر-هوش Agent خودمختار در سطح سازمانی، پیشگام گذار از پارادایم Harness Engineering به Loop Engineering، نسل جدیدی از زیرساخت هوش مصنوعی (AI Infra) برای مشتریان سازمانی است. پلتفرم DeepThink بر چارچوب همکاری چند-Agent متمرکز است و AI Coding، Self-Evolving، Full-Stack Observability، Bug Auto-Fix Loop و Human-Agent Symbiosis را ترکیب می‌کند تا یک سیستم هوش مصنوعی سازمانی بسازد که به طور مداوم یاد می‌گیرد، خود را بهبود می‌بخشد و در نهایت به ابر-هوش تبدیل می‌شود:

- **پلتفرم R&D خودمختار با هوش مصنوعی** — Agent به طور مستقل چرخه کامل توسعه نرم‌افزار را تکمیل می‌کند، بدون نیاز به مهندسان انسانی در وظایف برنامه‌نویسی روزمره
- **موتور Agent خود-تکاملی** — Agent به طور مداوم از خطاها یاد می‌گیرد، دانش را از پایگاه کد جذب می‌کند و از بازخورد کاربران تکامل می‌یابد
- **مرکز همکاری برنامه‌نویس-Agent** — هر برنامه‌نویس دارای یک «پروژه توسعه» شخصی است که شامل چندین جلسه موازی است و یک زمان‌بند مرکزی از تعارضات همزمانی جلوگیری می‌کند
- **پلتفرم SaaS سازمانی** — جداسازی چندمستاجری، مجوزهای سلسله‌مراتبی، صورت‌حساب انعطاف‌پذیر و یکپارچگی‌های سازمانی (Feishu/DingTalk/WeCom/LDAP)
- **انکوباتور ابر-هوش** — از طریق تکامل مداوم، در نهایت یک Agent واحد به قابلیت‌های جامع یک تیم نرم‌افزاری کامل دست می‌یابد

> «بگذارید هر سازمان صاحب یک تیم ابر-R&D هوش مصنوعی باشد که هرگز متوقف نمی‌شود و به طور مداوم تکامل می‌یابد — از کاربر ابزار، به خالق کد، و در نهایت رشد یافته به ابر-هوشی که خود را تکثیر می‌کند. بیایید با هم در مسیر رسیدن به AGI گام برداریم.»"`,

  'README.sv.md': `DeepThink, en företagsklassad plattform för själv-evolverande superintelligens för autonoma Agent, pionjär inom övergången från Harness Engineering- till Loop Engineering-paradigmet, är den nya generationens AI-infrastruktur (AI Infra) för företagskunder. DeepThink-plattformen centreras kring ett ramverk för multi-Agent-samarbete och smälter samman AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop och Human-Agent Symbiosis för att bygga ett företagsklassat AI-system som kontinuerligt lär sig, förbättrar sig självt och slutligen växer till en superintelligens:

- **AI-Autonom R&D-Plattform** — Agent slutför självständigt hela programvaruutvecklingslivscykeln, utan behov av mänskliga ingenjörer för rutinmässiga kodningsuppgifter
- **Själv-Evolverande Agent-Motor** — Agent lär sig kontinuerligt av fel, absorberar kunskap från kodbasen och utvecklas från användaråterkoppling
- **Programmerare-Agent-Samarbetshubb** — Varje programmerare äger ett personligt ”Utvecklingsprojekt” med flera parallella sessioner, och en central schemaläggare förhindrar samtidighetskonflikter
- **Företags-SaaS-Plattform** — Multi-tenant-isolering, nivåindelade rättigheter, elastisk fakturering och företagsintegrationer (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligens-Inkubator** — Genom kontinuerlig evolution uppnår en enskild Agent till slut de omfattande förmågorna hos ett komplett programvaruteam

> ”Låt varje företag äga ett AI-super-R&D-team som aldrig stannar och ständigt utvecklas — från verktygsanvändare, till kodskapare, slutligen växande till en själv-reproducerande superintelligens. Låt oss gå tillsammans på vägen mot AGI.”`,

  'README.cs.md': `DeepThink, platforma pro samo-vyvíjející se superinteligenci autonomního Agent na podnikové úrovni, průkopník přechodu od paradigmatu Harness Engineering k Loop Engineering, je novou generací AI infrastruktury (AI Infra) pro podnikové zákazníky. Platforma DeepThink se soustředí na rámec pro spolupráci více Agent, propojuje AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop a Human-Agent Symbiosis, aby vybudovala podnikový AI systém, který se neustále učí, sám se zdokonaluje a nakonec dorůstá v superinteligenci:

- **Platforma autonomního AI R&D** — Agent samostatně dokončuje celý životní cyklus vývoje softwaru, bez potřeby lidských inženýrů u rutinních kódovacích úkolů
- **Samo-vyvíjející se Agent Engine** — Agent se neustále učí z chyb, vstřebává znalosti z kódové základny a vyvíjí se na základě zpětné vazby od uživatelů
- **Centrum spolupráce programátor-Agent** — Každý programátor vlastní osobní „Vývojový projekt" s několika paralelními relacemi a centrální plánovač zabraňuje konfliktům souběžnosti
- **Podniková SaaS platforma** — Multi-tenant izolace, hierarchická oprávnění, elastické fakturace a podnikové integrace (Feishu/DingTalk/WeCom/LDAP)
- **Inkubátor superinteligence** — Prostřednictvím průběžné evoluce nakonec jeden Agent získá komplexní schopnosti kompletního softwarového týmu

> „Ať každý podnik vlastní AI super R&D tým, který se nikdy nezastaví a neustále se vyvíjí — od uživatele nástrojů, po tvůrce kódu, nakonec dorůstající v samo-replikující se superinteligenci. Pojďme kráčet společně na cestě k AGI."`,
};

const root = path.resolve(__dirname, '..');
let changed = 0;
let skipped = [];

for (const [filename, newContent] of Object.entries(translations)) {
  const filepath = path.join(root, filename);
  if (!fs.existsSync(filepath)) {
    skipped.push(`${filename} (missing)`);
    continue;
  }
  const content = fs.readFileSync(filepath, 'utf8');

  // Match: first `## ` heading line + everything up to (but not including) first `### ` heading line.
  // Replace the content between (exclusive of both headings) with the new translated block.
  const regex = /(^## [^\n]+\n)([\s\S]*?)(^### [^\n]+\n)/m;
  const m = content.match(regex);
  if (!m) {
    skipped.push(`${filename} (section not found)`);
    continue;
  }

  // Preserve one blank line after the heading, then content, then blank lines before `### `.
  const replacement = `${m[1]}\n${newContent}\n\n${m[3]}`;
  const newFileContent = content.replace(regex, replacement);
  if (newFileContent === content) {
    skipped.push(`${filename} (no change)`);
    continue;
  }
  fs.writeFileSync(filepath, newFileContent, 'utf8');
  changed++;
}

console.log(`changed: ${changed} / ${Object.keys(translations).length}`);
if (skipped.length) {
  console.log('skipped:');
  for (const s of skipped) console.log(`  - ${s}`);
}
