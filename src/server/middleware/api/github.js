const { graphql } = require('@octokit/graphql')
const NodeCache = require('node-cache')
const { AuthorizationCode } = require('simple-oauth2')
const crypto = require('crypto')

const config = require('../../../config')
const { isProduction } = require('../../utils')

const renderBody = (status, content) => `
<script>
  const receiveMessage = (message) => {
    window.opener.postMessage(
      'authorization:github:${status}:${JSON.stringify(content)}',
      message.origin
    );
    window.removeEventListener("message", receiveMessage, false);
  }
  window.addEventListener("message", receiveMessage, false);
  
  window.opener.postMessage("authorizing:github", "*");
</script>
`
const randomString = () => crypto.randomBytes(4).toString(`hex`)
const client = new AuthorizationCode(config.oauth2)
const cache = new NodeCache({ stdTTL: 900 })

async function getFreshGithubData() {
  try {
    const { repository } = await graphql(
      `
        {
          repository(owner: "iterative", name: "dvc") {
            stargazers {
              totalCount
            }
            issues(
              first: 3
              states: OPEN
              orderBy: { field: CREATED_AT, direction: DESC }
            ) {
              edges {
                node {
                  title
                  createdAt
                  url
                  comments {
                    totalCount
                  }
                }
              }
            }
          }
        }
      `,
      {
        headers: {
          authorization: `token ${process.env.GITHUB_TOKEN}`
        }
      }
    )

    const issues = repository.issues.edges.map(({ node }) => ({
      title: node.title,
      url: node.url,
      comments: node.comments.totalCount,
      date: node.createdAt
    }))

    const stars = repository.stargazers.totalCount

    cache.set('issues', issues)
    cache.set('stars', stars)

    return { issues, stars }
  } catch (e) {
    return { error: e.message || e }
  }
}

async function issues(_, res) {
  if (!process.env.GITHUB_TOKEN) {
    // We have no GitHub key, so reject as unauthorized
    res.status(403).send()
  } else {
    const cachedValue = cache.get('issues')
    if (cachedValue) {
      if (!isProduction) console.log('Using cache for "issues"')
      res.status(200).json({ issues: cachedValue })
    } else {
      console.log('Not using cache for "issues"')
      const { issues } = await getFreshGithubData()
      if (!issues) {
        // No cached nor fresh issues found: return 404
        res.status(404).send()
      } else {
        res.status(200).json({ issues })
      }
    }
  }
}

async function getStars() {
  const cachedValue = cache.get('stars')
  if (cachedValue) {
    if (!isProduction) console.log('Using cache for "stars"')
    return cachedValue
  } else {
    console.log('Not using cache for "stars"')
    const { stars } = await getFreshGithubData()
    return stars
  }
}

async function stars(req, res) {
  if (!process.env.GITHUB_TOKEN) {
    // We have no GitHub key, so reject as unauthorized
    res.status(403).send()
  } else {
    const stars = await getStars()
    if (stars) {
      // If we got stars, successfully return a data payload with them
      res.status(200).json({ stars })
    } else {
      // Stars are missing for some reason: return 404
      res.status(404).send()
    }
  }
}

async function auth(req, res) {
  const { host } = req.headers
  try {
    const url = client.authorizeURL({
      redirect_uri: `https://${host}/api/github/callback`,
      scope: `repo,user`,
      state: randomString()
    })
    res.redirect(url)
  } catch (error) {
    console.error(error)
    res.status(500).send(error)
  }
}

async function callback(req, res) {
  const { host } = req.headers
  const code = req.query.code
  try {
    const accessToken = await client.getToken({
      code,
      redirect_uri: `https://${host}/api/github/callback`
    })
    const { token } = client.createToken(accessToken)

    res.status(200).send(
      renderBody('success', {
        token: token.access_token,
        provider: 'github'
      })
    )
  } catch (e) {
    res.status(200).send(renderBody('error', e))
  }
}

module.exports = {
  stars,
  issues,
  auth,
  callback
}
