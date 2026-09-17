"use client";

/**
 * 页脚。
 *
 * 没配的联系方式显示成 [待填写]，不编一个 —— 编一个假邮箱的代价是有人真往那儿发信。
 * 同理，没配文档地址时那一条直接不出现，而不是给一个 404 的链接。
 */

import Link from "next/link";
import { useLocale } from "@/i18n/LocaleProvider";
import { orPlaceholder } from "@/utils/site";
import { useSiteConfig } from "@/components/site/SiteConfigProvider";
import { BrandMark } from "./icons";

/**
 * year 由外层的服务端组件算好传进来。
 *
 * 在这里 new Date().getFullYear() 会踩一个一年只出现一次的坑：HTML 是服务端渲的，
 * 12 月 31 日服务端（UTC）还是 2026、浏览器（UTC+8）已经是 2027，
 * 两边渲染出的文本不一样，React 会把整棵子树退回客户端重渲。
 */
export function Footer({ year }: { year: number }) {
  const { t } = useLocale();
  const siteConfig = useSiteConfig();

  return (
    <footer className="gp-footer">
      <div className="gp-page">
        <div className="gp-footer__top">
          <div className="gp-footer__col">
            <Link className="gp-brand" href="/" style={{ marginBottom: 14 }}>
              <BrandMark className="gp-brand__mark" />
              <span className="gp-brand__name">{t("brand.name")}</span>
              <span className="gp-brand__tag">{t("brand.tag")}</span>
            </Link>
            <p className="gp-body" style={{ maxWidth: "34ch", fontSize: 13.5 }}>
              {t("footer.tagline")}
            </p>
          </div>

          <div className="gp-footer__col">
            <h4>{t("footer.product")}</h4>
            <ul>
              <li>
                <Link href="/models">{t("nav.models")}</Link>
              </li>
              <li>
                <Link href="/pricing">{t("nav.pricing")}</Link>
              </li>
              <li>
                <a href={siteConfig.consoleURL}>{t("footer.console")}</a>
              </li>
            </ul>
          </div>

          <div className="gp-footer__col">
            <h4>{t("footer.resources")}</h4>
            <ul>
              {siteConfig.docsURL ? (
                <li>
                  <a href={siteConfig.docsURL}>{t("footer.docs")}</a>
                </li>
              ) : null}
              <li>
                <Link href="/contact">{t("nav.contact")}</Link>
              </li>
              <li>
                <Link href="/pricing#faq">{t("home.faq.title")}</Link>
              </li>
            </ul>
          </div>

          <div className="gp-footer__col">
            <h4>{t("footer.company")}</h4>
            <ul>
              <li>
                {t("contact.side.email")}：
                {siteConfig.contactEmail ? (
                  <a href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</a>
                ) : (
                  orPlaceholder("")
                )}
              </li>
              <li>
                {t("contact.side.wechat")}：{orPlaceholder(siteConfig.contactWechat)}
              </li>
            </ul>
          </div>
        </div>

        <div className="gp-footer__bottom">
          <span>
            © {year} {t("brand.name")} · {t("footer.rights")}
          </span>
          {siteConfig.icp ? (
            <a href="https://beian.miit.gov.cn/" rel="noreferrer noopener" target="_blank">
              {siteConfig.icp}
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
